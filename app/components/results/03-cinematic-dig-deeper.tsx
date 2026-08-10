/**
 * A cinematic, filterable browser for the additional passages returned by the
 * live search response. Facets come only from structured wire fields or strict
 * reference formats; presentation labels are never treated as metadata.
 */
"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
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

export type DigDeeperSort = "relevance" | "newest";
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

export function sortAdditionalSearchPassages(
  rows: readonly ParsedAdditionalSearchPassage[],
  sort: DigDeeperSort,
): ParsedAdditionalSearchPassage[] {
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

function uniqueValues(
  rows: readonly ParsedAdditionalSearchPassage[],
  read: (row: ParsedAdditionalSearchPassage) => string | null,
  newestFirst = false,
): string[] {
  const values = Array.from(new Set(rows.map(read).filter((value): value is string => Boolean(value))));
  return values.sort((left, right) =>
    newestFirst
      ? right.localeCompare(left, "en", { numeric: true })
      : left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }),
  );
}

function uniqueSpeakers(rows: readonly ParsedAdditionalSearchPassage[]): string[] {
  const speakers = new Set<string>();
  for (const row of rows) {
    for (const speaker of row.speakers ?? []) speakers.add(speaker);
  }
  return Array.from(speakers).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
}

function availableFamilies(
  rows: readonly ParsedAdditionalSearchPassage[],
): Array<{ value: DigDeeperContentFamily; label: string }> {
  const seenSignatures = new Set<string>();
  const choices: Array<{ value: DigDeeperContentFamily; label: string }> = [];

  for (const definition of FAMILY_DEFINITIONS) {
    const signature = rows
      .filter((row) => passageMatchesContentFamily(row, definition.value))
      .map((row) => row.originalIndex)
      .join(",");
    if (!signature || seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    choices.push(definition);
  }
  return choices;
}

function groupRows(
  rows: readonly ParsedAdditionalSearchPassage[],
): Array<{ name: string; rows: ParsedAdditionalSearchPassage[] }> {
  const groups = new Map<string, ParsedAdditionalSearchPassage[]>();
  for (const row of rows) {
    const group = groups.get(row.sourceGroup);
    if (group) group.push(row);
    else groups.set(row.sourceGroup, [row]);
  }
  return Array.from(groups, ([name, groupedRows]) => ({ name, rows: groupedRows }));
}

function scoreLabel(score: number | null): string | null {
  if (score === null || !Number.isFinite(score)) return null;
  return `Relevance ${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

function visibleMetadata(row: ParsedAdditionalSearchPassage): string[] {
  const values = [
    row.occasion,
    row.book,
    row.division,
    row.chapter,
    row.passage.speaker ? `Speaker: ${row.passage.speaker}` : null,
    row.passage.recipient ? `To: ${row.passage.recipient}` : null,
    row.passage.location,
    row.passage.date,
  ];
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value !== UNKNOWN_METADATA))));
}

interface FilterSelectProps {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}

function FilterSelect({ id, label, value, options, onChange }: FilterSelectProps) {
  // One proved value is still a useful facet because it can isolate those rows
  // from every row where the field does not apply.
  if (options.length === 0) return null;
  return (
    <label className="dd-field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={ALL}>All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

interface PassageCardProps {
  row: ParsedAdditionalSearchPassage;
  headingLevel: 3 | 4;
}

function PassageCard({ row, headingLevel }: PassageCardProps) {
  const passage = row.passage;
  const rank = row.originalIndex + 1;
  const metadata = visibleMetadata(row);
  const relevance = scoreLabel(passage.rerankScore);
  const Heading = headingLevel === 3 ? "h3" : "h4";

  return (
    <article className="dd-card">
      <div className="dd-card-head">
        <span className="dd-rank" aria-label={`Original search rank ${rank}`}>
          {String(rank).padStart(2, "0")}
        </span>
        <div className="dd-card-title-wrap">
          <p className="dd-kind">{TYPE_LABELS[passage.type]}</p>
          <Heading>{passage.label}</Heading>
        </div>
      </div>

      {metadata.length > 0 ? (
        <ul className="dd-metadata" aria-label="Passage metadata">
          {metadata.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}

      {passage.provenanceNote ? (
        <p className="dd-provenance">{passage.provenanceNote}</p>
      ) : null}
      {passage.snippet ? <p className="dd-snippet">{passage.snippet}</p> : null}

      <footer className="dd-card-foot">
        <div>
          {passage.reference ? <span className="dd-reference">{passage.reference}</span> : null}
          {relevance ? <span className="dd-score">{relevance}</span> : null}
        </div>
        {passage.url ? (
          <a
            href={passage.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${passage.reference || passage.label} on Vedabase in a new tab`}
          >
            Open source <span aria-hidden="true">↗</span>
          </a>
        ) : null}
      </footer>
    </article>
  );
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
}

interface CinematicDigDeeperProps {
  list: AdditionalSearchPassage[];
  truncated?: boolean;
  /** The server's true additionalCount when the visible response was shortened. */
  totalCount?: number;
}

export default function CinematicDigDeeper({
  list,
  truncated = false,
  totalCount,
}: CinematicDigDeeperProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filters, setFilters] = useState<DigDeeperFilters>(() => ({ ...EMPTY_FILTERS }));
  const [sort, setSort] = useState<DigDeeperSort>("relevance");
  const [grouping, setGrouping] = useState<DigDeeperGrouping>("ranked");
  const [mobileFacetsOpen, setMobileFacetsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const contentFilterId = useId();
  const mobileFacetsId = useId();
  const occasionId = useId();
  const bookId = useId();
  const divisionId = useId();
  const chapterId = useId();
  const speakerId = useId();
  const locationId = useId();
  const recipientId = useId();
  const yearId = useId();
  const searchId = useId();
  const sortId = useId();

  const parsed = useMemo(
    () => isOpen
      ? list.map((passage, index) => parseAdditionalSearchPassage(passage, index))
      : [],
    [isOpen, list],
  );
  const declaredTotal = typeof totalCount === "number" && Number.isFinite(totalCount)
    ? Math.trunc(totalCount)
    : list.length;
  const trueTotal = Math.max(list.length, declaredTotal);
  const familyChoices = useMemo(() => availableFamilies(parsed), [parsed]);
  const facetRows = useMemo(
    () => parsed.filter((row) => passageMatchesContentFamily(row, filters.family)),
    [parsed, filters.family],
  );
  const facetOptions = useMemo(
    () => ({
      occasion: uniqueValues(facetRows, (row) => row.occasion),
      book: uniqueValues(facetRows, (row) => row.book),
      division: uniqueValues(facetRows, (row) => row.division),
      chapter: uniqueValues(facetRows, (row) => row.chapter),
      speaker: uniqueSpeakers(facetRows),
      location: uniqueValues(facetRows, (row) => row.location),
      recipient: uniqueValues(facetRows, (row) => row.recipient),
      year: uniqueValues(facetRows, (row) => row.year, true),
    }),
    [facetRows],
  );
  const filtered = useMemo(
    () => filterAdditionalSearchPassages(parsed, filters),
    [parsed, filters],
  );
  const sorted = useMemo(() => sortAdditionalSearchPassages(filtered, sort), [filtered, sort]);
  const grouped = useMemo(() => groupRows(sorted), [sorted]);
  const activeFilterCount = useMemo(
    () =>
      Number(filters.family !== "all") +
      Number(Boolean(filters.query.trim())) +
      Number(Boolean(filters.occasion)) +
      Number(Boolean(filters.book)) +
      Number(Boolean(filters.division)) +
      Number(Boolean(filters.chapter)) +
      Number(Boolean(filters.speaker)) +
      Number(Boolean(filters.location)) +
      Number(Boolean(filters.recipient)) +
      Number(Boolean(filters.year)),
    [filters],
  );

  const openDialog = useCallback(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : triggerRef.current;
    setMobileFacetsOpen(false);
    setIsOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setIsOpen(false);
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    searchRef.current?.focus({ preventScroll: true });

    const portal = document.querySelector<HTMLElement>("[data-cinematic-dig-deeper-portal]");
    const backgroundState: Array<{
      element: HTMLElement;
      ariaHidden: string | null;
      hadInert: boolean;
    }> = [];

    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement) || child === portal || child.tagName === "SCRIPT") continue;
      backgroundState.push({
        element: child,
        ariaHidden: child.getAttribute("aria-hidden"),
        hadInert: child.hasAttribute("inert"),
      });
      child.setAttribute("aria-hidden", "true");
      child.setAttribute("inert", "");
    }

    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const previousOverscroll = document.body.style.overscrollBehavior;
    const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    if (scrollbarWidth > 0) {
      const currentPadding = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${currentPadding + scrollbarWidth}px`;
    }

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      document.body.style.overscrollBehavior = previousOverscroll;
      for (const state of backgroundState) {
        if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
        if (!state.hadInert) state.element.removeAttribute("inert");
      }
    };
  }, [isOpen]);

  const handleDialogKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first || active === dialogRef.current || !dialogRef.current.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [closeDialog],
  );

  const updateFilter = useCallback((key: keyof DigDeeperFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  }, []);

  const selectFamily = useCallback((family: DigDeeperContentFamily) => {
    setFilters((current) => ({ ...EMPTY_FILTERS, query: current.query, family }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ ...EMPTY_FILTERS });
    setSort("relevance");
    setGrouping("ranked");
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  const handleSearch = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setFilters((current) => ({ ...current, query: value }));
  }, []);

  if (list.length === 0) return null;

  const statusText = truncated || trueTotal > list.length
    ? `Showing ${sorted.length.toLocaleString("en-US")} of ${list.length.toLocaleString("en-US")} visible passages · ${trueTotal.toLocaleString("en-US")} retrieved in this search`
    : `Showing ${sorted.length.toLocaleString("en-US")} of ${trueTotal.toLocaleString("en-US")} passages retrieved in this search`;

  const modal = isOpen ? (
    <div data-cinematic-dig-deeper-portal className="dd-portal">
      <div className="dd-scrim" aria-hidden="true" onPointerDown={closeDialog} />
      <section
        ref={dialogRef}
        className="dd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="dd-aura dd-aura-one" aria-hidden="true" />
        <div className="dd-aura dd-aura-two" aria-hidden="true" />

        <header className="dd-dialog-head">
          <div className="dd-orbit dd-orbit-small" aria-hidden="true">
            <span>✦</span>
          </div>
          <div className="dd-heading-copy">
            <p className="dd-eyebrow">Additional evidence · this search</p>
            <h2 id={titleId}>Dig deeper</h2>
            <p id={descriptionId}>
              Arrange these retrieved passages by source, place, time, speaker, or reference.
            </p>
          </div>
          <div className="dd-head-actions">
            <span className="dd-total-pill">
              <strong>{trueTotal.toLocaleString("en-US")}</strong>
              <span>{trueTotal === 1 ? "passage" : "passages"}</span>
            </span>
            <button type="button" className="dd-close" onClick={closeDialog} aria-label="Close Dig deeper">
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        <div className="dd-dialog-body">
          <aside className={`dd-facets${mobileFacetsOpen ? " is-mobile-open" : ""}`} aria-label="Dig deeper filters">
            <div className="dd-facet-heading">
              <div>
                <p>Refine the view</p>
                <span>{activeFilterCount ? `${activeFilterCount} active` : "No filters active"}</span>
              </div>
              <div className="dd-facet-actions">
                <button
                  type="button"
                  className="dd-mobile-facet-toggle"
                  aria-expanded={mobileFacetsOpen}
                  aria-controls={mobileFacetsId}
                  onClick={() => setMobileFacetsOpen((open) => !open)}
                >
                  {mobileFacetsOpen ? "Hide filters" : "Show filters"}
                </button>
                {activeFilterCount > 0 || sort !== "relevance" || grouping !== "ranked" ? (
                  <button type="button" onClick={clearFilters}>Clear filters</button>
                ) : null}
              </div>
            </div>

            <div id={mobileFacetsId} className="dd-facet-content">
              {familyChoices.length > 1 ? (
                <fieldset className="dd-family" aria-labelledby={contentFilterId}>
                  <legend id={contentFilterId}>Content</legend>
                  <div>
                    {familyChoices.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className={filters.family === choice.value ? "is-active" : undefined}
                        aria-pressed={filters.family === choice.value}
                        onClick={() => selectFamily(choice.value)}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              <div className="dd-select-grid">
                <FilterSelect id={occasionId} label="Occasion" value={filters.occasion} options={facetOptions.occasion} onChange={(value) => updateFilter("occasion", value)} />
                <FilterSelect id={bookId} label="Book / scripture" value={filters.book} options={facetOptions.book} onChange={(value) => updateFilter("book", value)} />
                <FilterSelect id={divisionId} label="Skandha / canto / division" value={filters.division} options={facetOptions.division} onChange={(value) => updateFilter("division", value)} />
                <FilterSelect id={chapterId} label="Chapter" value={filters.chapter} options={facetOptions.chapter} onChange={(value) => updateFilter("chapter", value)} />
                <FilterSelect id={speakerId} label="Speaker" value={filters.speaker} options={facetOptions.speaker} onChange={(value) => updateFilter("speaker", value)} />
                <FilterSelect id={locationId} label="Location" value={filters.location} options={facetOptions.location} onChange={(value) => updateFilter("location", value)} />
                <FilterSelect id={recipientId} label="Recipient" value={filters.recipient} options={facetOptions.recipient} onChange={(value) => updateFilter("recipient", value)} />
                <FilterSelect id={yearId} label="Year" value={filters.year} options={facetOptions.year} onChange={(value) => updateFilter("year", value)} />
              </div>

              {truncated || trueTotal > list.length ? (
                <p className="dd-truncated">
                  The visible list was shortened to fit the response. The retrieved count above remains the true count.
                </p>
              ) : null}
            </div>
          </aside>

          <main className="dd-results">
            <div className="dd-tools">
              <label className="dd-search" htmlFor={searchId}>
                <span className="dd-visually-hidden">Search within these passages</span>
                <span className="dd-search-icon" aria-hidden="true">⌕</span>
                <input
                  ref={searchRef}
                  id={searchId}
                  type="search"
                  value={filters.query}
                  onChange={handleSearch}
                  placeholder="Search within these passages"
                  autoComplete="off"
                />
              </label>

              <div className="dd-tool-row">
                <p className="dd-status" role="status" aria-live="polite">
                  {statusText}
                </p>
                <div className="dd-view-controls">
                  <label className="dd-sort" htmlFor={sortId}>
                    <span>Sort</span>
                    <select id={sortId} value={sort} onChange={(event) => setSort(event.target.value as DigDeeperSort)}>
                      <option value="relevance">Relevance</option>
                      <option value="newest">Newest</option>
                    </select>
                  </label>
                  <div className="dd-grouping" aria-label="Result grouping">
                    <button type="button" aria-pressed={grouping === "ranked"} onClick={() => setGrouping("ranked")}>Ranked</button>
                    <button type="button" aria-pressed={grouping === "source"} onClick={() => setGrouping("source")}>By source</button>
                  </div>
                </div>
              </div>
            </div>

            <div className="dd-results-scroll">
              {sorted.length === 0 ? (
                <div className="dd-empty">
                  <span aria-hidden="true">◇</span>
                  <h3>No passages match this view</h3>
                  <p>Clear one or more filters, or try a different phrase.</p>
                  <button type="button" onClick={clearFilters}>Clear filters</button>
                </div>
              ) : grouping === "source" ? (
                <div className="dd-groups">
                  {grouped.map((group) => (
                    <section key={group.name} className="dd-source-group">
                      <header>
                        <h3>{group.name}</h3>
                        <span>{group.rows.length.toLocaleString("en-US")}</span>
                      </header>
                      <div className="dd-card-list">
                        {group.rows.map((row) => (
                          <PassageCard key={`${row.passage.type}:${row.passage.reference ?? row.passage.label}:${row.originalIndex}`} row={row} headingLevel={4} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="dd-card-list">
                  {sorted.map((row) => (
                    <PassageCard key={`${row.passage.type}:${row.passage.reference ?? row.passage.label}:${row.originalIndex}`} row={row} headingLevel={3} />
                  ))}
                </div>
              )}
            </div>
          </main>
        </div>
      </section>

      <style jsx global>{`
        .dd-portal, .dd-portal * { box-sizing: border-box; }
        .dd-portal { position: fixed; inset: 0; z-index: 520; min-width: 0; font-family: var(--font-body), 'DM Sans', system-ui, sans-serif; color: var(--ink); }
        .dd-scrim { position: absolute; inset: 0; background: color-mix(in srgb, var(--ink-strong) 54%, transparent); backdrop-filter: blur(12px) saturate(0.8); -webkit-backdrop-filter: blur(12px) saturate(0.8); animation: ddFade var(--dur-3, 240ms) var(--ease-standard, ease-out) both; }
        .dd-dialog { position: absolute; isolation: isolate; left: 50%; top: 50%; display: grid; width: min(1180px, calc(100vw - max(32px, env(safe-area-inset-left, 0px)) - max(32px, env(safe-area-inset-right, 0px)))); height: min(860px, calc(100dvh - max(24px, env(safe-area-inset-top, 0px)) - max(24px, env(safe-area-inset-bottom, 0px)))); min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; transform: translate(-50%, -50%); border: 1px solid color-mix(in srgb, var(--p-gold) 22%, var(--border-hair)); border-radius: 28px; background: color-mix(in srgb, var(--surface-raised) 96%, #fff8e8); box-shadow: 0 30px 100px color-mix(in srgb, var(--ink-strong) 30%, transparent), 0 0 0 1px color-mix(in srgb, white 30%, transparent) inset; animation: ddArrive var(--dur-4, 360ms) var(--ease-decelerate, ease-out) both; }
        .dd-dialog:focus { outline: none; }
        .dd-aura { position: absolute; z-index: -1; pointer-events: none; border-radius: 50%; filter: blur(2px); opacity: 0.85; }
        .dd-aura-one { width: 420px; height: 420px; top: -280px; left: 10%; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 18%, transparent), transparent 68%); }
        .dd-aura-two { width: 360px; height: 360px; right: -220px; bottom: -220px; background: radial-gradient(circle, color-mix(in srgb, var(--p-gold) 17%, transparent), transparent 68%); }
        .dd-dialog-head { position: relative; display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 22px 24px; border-bottom: 1px solid color-mix(in srgb, var(--border-hair) 76%, transparent); background: linear-gradient(105deg, color-mix(in srgb, var(--accent-tint) 54%, transparent), color-mix(in srgb, var(--surface-raised) 86%, transparent) 50%, color-mix(in srgb, var(--p-gold) 9%, transparent)); }
        .dd-orbit { position: relative; display: grid; width: 58px; height: 58px; flex: 0 0 auto; place-items: center; border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent); border-radius: 50%; color: var(--accent-strong); background: color-mix(in srgb, var(--surface-raised) 72%, transparent); box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 5%, transparent), 0 8px 26px color-mix(in srgb, var(--accent) 12%, transparent); }
        .dd-orbit::before, .dd-orbit::after { content: ''; position: absolute; inset: 7px -5px; border: 1px solid color-mix(in srgb, var(--p-gold) 38%, transparent); border-radius: 50%; transform: rotate(55deg); }
        .dd-orbit::after { transform: rotate(-55deg); }
        .dd-orbit span { font-size: 18px; animation: ddBreathe 4s ease-in-out infinite; }
        .dd-heading-copy { min-width: 0; }
        .dd-heading-copy p, .dd-heading-copy h2 { overflow-wrap: anywhere; }
        .dd-eyebrow { margin: 0 0 3px; color: var(--accent-strong); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
        .dd-heading-copy h2 { margin: 0; color: var(--ink-strong); font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(1.8rem, 3vw, 2.45rem); font-weight: 500; line-height: 1; letter-spacing: -0.02em; }
        .dd-heading-copy > p:last-child { max-width: 670px; margin: 5px 0 0; color: var(--ink-muted); font-size: 0.83rem; line-height: 1.45; }
        .dd-head-actions { display: flex; min-width: 0; align-items: center; gap: 12px; }
        .dd-total-pill { display: flex; min-width: 82px; min-height: 48px; flex-direction: column; align-items: center; justify-content: center; padding: 5px 14px; border: 1px solid color-mix(in srgb, var(--p-gold) 34%, var(--border-hair)); border-radius: 999px; color: var(--ink-muted); background: color-mix(in srgb, var(--p-gold) 7%, var(--surface-raised)); line-height: 1.05; }
        .dd-total-pill strong { color: var(--ink-strong); font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: 1.25rem; font-weight: 600; }
        .dd-total-pill span { font-size: 0.62rem; letter-spacing: 0.06em; text-transform: uppercase; }
        .dd-close { display: inline-grid; width: 44px; min-width: 44px; height: 44px; padding: 0; place-items: center; border: 1px solid var(--border-hair); border-radius: 50%; color: var(--ink-muted); background: color-mix(in srgb, var(--surface-raised) 82%, transparent); font-size: 1.55rem; line-height: 1; cursor: pointer; transition: transform var(--dur-2) var(--ease-standard), border-color var(--dur-2) var(--ease-standard), color var(--dur-2) var(--ease-standard); }
        .dd-close:hover { transform: rotate(6deg); border-color: var(--accent); color: var(--accent-strong); }
        .dd-dialog-body { display: grid; min-width: 0; min-height: 0; grid-template-columns: minmax(250px, 292px) minmax(0, 1fr); }
        .dd-facets { min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 22px 20px max(22px, env(safe-area-inset-bottom, 0px)); border-right: 1px solid color-mix(in srgb, var(--border-hair) 78%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--accent-tint) 28%, var(--surface-sunken)), color-mix(in srgb, var(--surface-sunken) 72%, transparent)); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--accent) 36%, transparent) transparent; }
        .dd-facet-heading { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 17px; }
        .dd-facet-heading div { min-width: 0; }
        .dd-facet-heading p { margin: 0; color: var(--ink-strong); font-size: 0.9rem; font-weight: 700; overflow-wrap: anywhere; }
        .dd-facet-heading span { display: block; margin-top: 2px; color: var(--ink-subtle); font-size: 0.7rem; }
        .dd-facet-heading button { min-height: 44px; flex: 0 1 auto; padding: 6px 4px; border: 0; color: var(--accent-strong); background: transparent; font: inherit; font-size: 0.72rem; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
        .dd-facet-actions { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 10px; }
        .dd-mobile-facet-toggle { display: none; }
        .dd-family { min-width: 0; margin: 0 0 17px; padding: 0; border: 0; }
        .dd-family legend, .dd-field > span, .dd-sort > span { margin: 0 0 7px; color: var(--ink-subtle); font-size: 0.67rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
        .dd-family > div { display: flex; min-width: 0; flex-wrap: wrap; gap: 7px; }
        .dd-family button { min-width: 0; min-height: 44px; max-width: 100%; padding: 7px 11px; border: 1px solid var(--border-hair); border-radius: 999px; color: var(--ink-muted); background: color-mix(in srgb, var(--surface-raised) 74%, transparent); font: inherit; font-size: 0.72rem; line-height: 1.25; overflow-wrap: anywhere; cursor: pointer; transition: border-color var(--dur-2) var(--ease-standard), background var(--dur-2) var(--ease-standard), color var(--dur-2) var(--ease-standard), transform var(--dur-2) var(--ease-standard); }
        .dd-family button:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border-hair)); color: var(--accent-strong); transform: translateY(-1px); }
        .dd-family button.is-active { border-color: color-mix(in srgb, var(--accent) 56%, var(--p-gold)); color: var(--surface-raised); background: linear-gradient(135deg, var(--accent), var(--accent-strong)); box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 18%, transparent); }
        .dd-select-grid { display: grid; min-width: 0; grid-template-columns: 1fr; gap: 12px; }
        .dd-field { display: flex; min-width: 0; flex-direction: column; }
        .dd-field > span { margin-bottom: 5px; overflow-wrap: anywhere; }
        .dd-field select, .dd-sort select { width: 100%; max-width: 100%; min-height: 44px; padding: 8px 34px 8px 11px; border: 1px solid var(--border-hair); border-radius: 11px; color: var(--ink); background: var(--surface-raised); font: inherit; font-size: 0.78rem; text-overflow: ellipsis; cursor: pointer; }
        .dd-truncated { margin: 17px 0 0; padding: 11px 12px; border-left: 2px solid var(--p-gold); border-radius: 0 10px 10px 0; color: var(--ink-muted); background: color-mix(in srgb, var(--p-gold) 8%, transparent); font-size: 0.73rem; line-height: 1.5; overflow-wrap: anywhere; }
        .dd-results { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; background: color-mix(in srgb, var(--surface-raised) 76%, transparent); }
        .dd-tools { position: relative; z-index: 2; flex: 0 0 auto; min-width: 0; padding: 17px 20px 13px; border-bottom: 1px solid color-mix(in srgb, var(--border-hair) 68%, transparent); background: color-mix(in srgb, var(--surface-raised) 88%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
        .dd-search { position: relative; display: flex; min-width: 0; align-items: center; }
        .dd-search-icon { position: absolute; left: 14px; z-index: 1; color: var(--accent-strong); font-family: Georgia, serif; font-size: 1.25rem; pointer-events: none; }
        .dd-search input { width: 100%; min-width: 0; min-height: 46px; padding: 10px 14px 10px 42px; border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-hair)); border-radius: 15px; color: var(--ink); background: color-mix(in srgb, var(--surface-raised) 94%, transparent); box-shadow: 0 7px 22px color-mix(in srgb, var(--ink-strong) 4%, transparent) inset; font: inherit; font-size: 0.86rem; }
        .dd-search input::placeholder { color: var(--ink-subtle); opacity: 1; }
        .dd-tool-row { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
        .dd-status { min-width: 0; margin: 0; color: var(--ink-muted); font-size: 0.73rem; line-height: 1.4; overflow-wrap: anywhere; }
        .dd-view-controls { display: flex; min-width: 0; flex: 0 1 auto; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
        .dd-sort { display: flex; min-width: 0; align-items: center; gap: 6px; }
        .dd-sort > span { margin: 0; }
        .dd-sort select { width: auto; min-width: 112px; border-radius: 999px; padding-top: 6px; padding-bottom: 6px; }
        .dd-grouping { display: inline-flex; min-width: 0; padding: 2px; border: 1px solid var(--border-hair); border-radius: 999px; background: var(--surface-sunken); }
        .dd-grouping button { min-width: 0; min-height: 44px; padding: 6px 11px; border: 0; border-radius: 999px; color: var(--ink-muted); background: transparent; font: inherit; font-size: 0.72rem; font-weight: 650; white-space: nowrap; cursor: pointer; }
        .dd-grouping button[aria-pressed='true'] { color: var(--accent-strong); background: var(--surface-raised); box-shadow: 0 3px 10px color-mix(in srgb, var(--ink-strong) 8%, transparent); }
        .dd-results-scroll { min-width: 0; min-height: 0; flex: 1 1 auto; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 18px 20px max(22px, env(safe-area-inset-bottom, 0px)); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--accent) 36%, transparent) transparent; }
        .dd-card-list { display: grid; min-width: 0; gap: 12px; }
        .dd-card { position: relative; min-width: 0; padding: 17px 18px; border: 1px solid color-mix(in srgb, var(--border-hair) 82%, transparent); border-radius: 17px; overflow: hidden; background: linear-gradient(115deg, color-mix(in srgb, var(--surface-raised) 98%, transparent), color-mix(in srgb, var(--accent-tint) 15%, var(--surface-raised))); box-shadow: 0 7px 24px color-mix(in srgb, var(--ink-strong) 4%, transparent); content-visibility: auto; contain-intrinsic-size: 0 230px; }
        .dd-card::after { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 3px; background: linear-gradient(180deg, var(--accent), var(--p-gold)); opacity: 0.58; }
        .dd-card-head { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 12px; }
        .dd-rank { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid color-mix(in srgb, var(--p-gold) 32%, var(--border-hair)); border-radius: 50%; color: var(--accent-strong); background: color-mix(in srgb, var(--p-gold) 7%, var(--surface-raised)); font-family: var(--font-display), Georgia, serif; font-size: 0.82rem; }
        .dd-card-title-wrap { min-width: 0; }
        .dd-kind { margin: 1px 0 3px; color: var(--accent-strong); font-size: 0.63rem; font-weight: 750; letter-spacing: 0.11em; text-transform: uppercase; }
        .dd-card h3, .dd-card h4 { margin: 0; color: var(--ink-strong); font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(1.08rem, 2vw, 1.28rem); font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }
        .dd-metadata { display: flex; min-width: 0; flex-wrap: wrap; gap: 6px; margin: 12px 0 0 46px; padding: 0; list-style: none; }
        .dd-metadata li { max-width: 100%; padding: 4px 8px; border: 1px solid color-mix(in srgb, var(--border-hair) 80%, transparent); border-radius: 999px; color: var(--ink-muted); background: color-mix(in srgb, var(--surface-sunken) 55%, transparent); font-size: 0.66rem; line-height: 1.35; overflow-wrap: anywhere; }
        .dd-provenance { margin: 12px 0 0 46px; padding: 8px 10px; border-left: 2px solid var(--p-gold); color: var(--ink-muted); background: color-mix(in srgb, var(--p-gold) 7%, transparent); font-size: 0.72rem; line-height: 1.5; overflow-wrap: anywhere; }
        .dd-snippet { margin: 13px 0 0 46px; color: var(--ink); font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(1rem, 1.75vw, 1.12rem); line-height: 1.55; overflow-wrap: anywhere; }
        .dd-card-foot { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; margin: 12px 0 0 46px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--border-hair) 62%, transparent); }
        .dd-card-foot > div { display: flex; min-width: 0; flex: 1 1 220px; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
        .dd-reference, .dd-score { max-width: 100%; color: var(--ink-muted); font-size: 0.69rem; line-height: 1.4; overflow-wrap: anywhere; }
        .dd-score { color: var(--ink-subtle); }
        .dd-card-foot a { display: inline-flex; min-width: 44px; min-height: 44px; align-items: center; justify-content: center; gap: 5px; padding: 6px 3px; color: var(--accent-strong); font-size: 0.74rem; font-weight: 750; text-decoration: none; }
        .dd-card-foot a:hover { text-decoration: underline; text-underline-offset: 3px; }
        .dd-source-group + .dd-source-group { margin-top: 25px; }
        .dd-source-group > header { display: flex; min-width: 0; align-items: center; gap: 10px; margin: 0 2px 10px; }
        .dd-source-group > header::after { content: ''; min-width: 20px; height: 1px; flex: 1 1 auto; background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 26%, var(--border-hair)), transparent); }
        .dd-source-group h3 { min-width: 0; margin: 0; color: var(--ink-strong); font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: 1.08rem; font-weight: 600; overflow-wrap: anywhere; }
        .dd-source-group > header span { order: 3; display: grid; min-width: 28px; height: 28px; padding: 0 7px; place-items: center; border-radius: 999px; color: var(--accent-strong); background: var(--accent-tint); font-size: 0.68rem; }
        .dd-empty { display: grid; min-height: 320px; padding: 36px 18px; place-items: center; align-content: center; text-align: center; }
        .dd-empty > span { color: color-mix(in srgb, var(--accent) 62%, var(--p-gold)); font-size: 2rem; }
        .dd-empty h3 { margin: 10px 0 4px; color: var(--ink-strong); font-family: var(--font-display), Georgia, serif; font-size: 1.45rem; font-weight: 600; }
        .dd-empty p { max-width: 340px; margin: 0; color: var(--ink-muted); font-size: 0.83rem; line-height: 1.5; }
        .dd-empty button { min-height: 44px; margin-top: 14px; padding: 8px 17px; border: 1px solid var(--accent); border-radius: 999px; color: var(--surface-raised); background: var(--accent-strong); font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; }
        .dd-close:focus-visible, .dd-facet-heading button:focus-visible, .dd-family button:focus-visible, .dd-field select:focus-visible, .dd-search input:focus-visible, .dd-sort select:focus-visible, .dd-grouping button:focus-visible, .dd-card-foot a:focus-visible, .dd-empty button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent-strong) 78%, white); outline-offset: 3px; }
        .dd-visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }

        @keyframes ddFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ddArrive { from { opacity: 0; transform: translate(-50%, calc(-50% + 22px)) scale(0.985); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
        @keyframes ddBreathe { 0%, 100% { opacity: 0.72; transform: scale(0.9) rotate(0deg); } 50% { opacity: 1; transform: scale(1.12) rotate(18deg); } }

        @media (max-width: 900px) {
          .dd-dialog { width: calc(100vw - max(18px, env(safe-area-inset-left, 0px)) - max(18px, env(safe-area-inset-right, 0px))); height: calc(100dvh - max(14px, env(safe-area-inset-top, 0px)) - max(14px, env(safe-area-inset-bottom, 0px))); border-radius: 23px; }
          .dd-dialog-body { grid-template-columns: minmax(220px, 252px) minmax(0, 1fr); }
          .dd-dialog-head { padding: 17px 18px; }
          .dd-orbit { width: 50px; height: 50px; }
          .dd-total-pill { display: none; }
          .dd-facets { padding: 18px 15px max(18px, env(safe-area-inset-bottom, 0px)); }
          .dd-tools { padding-right: 15px; padding-left: 15px; }
          .dd-results-scroll { padding-right: 15px; padding-left: 15px; }
          .dd-tool-row { align-items: flex-start; flex-direction: column; }
          .dd-view-controls { width: 100%; justify-content: space-between; }
        }

        @media (max-width: 700px) {
          .dd-dialog { left: 0; top: auto; bottom: 0; width: 100%; height: calc(100dvh - env(safe-area-inset-top, 0px)); max-height: 100dvh; transform: none; border-right: 0; border-bottom: 0; border-left: 0; border-radius: 23px 23px 0 0; animation-name: ddRise; }
          .dd-dialog-head { grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; padding-top: max(14px, env(safe-area-inset-top, 0px)); padding-right: max(14px, env(safe-area-inset-right, 0px)); padding-bottom: 13px; padding-left: max(14px, env(safe-area-inset-left, 0px)); }
          .dd-orbit { width: 42px; height: 42px; }
          .dd-orbit::before, .dd-orbit::after { inset: 5px -4px; }
          .dd-heading-copy > p:last-child { display: none; }
          .dd-heading-copy h2 { font-size: clamp(1.5rem, 8vw, 1.9rem); }
          .dd-eyebrow { font-size: 0.59rem; letter-spacing: 0.1em; }
          .dd-dialog-body { display: block; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
          .dd-facets { overflow: visible; padding: 15px max(14px, env(safe-area-inset-right, 0px)) 16px max(14px, env(safe-area-inset-left, 0px)); border-right: 0; border-bottom: 1px solid var(--border-hair); }
          .dd-facet-heading { margin-bottom: 0; }
          .dd-mobile-facet-toggle { display: inline-flex; align-items: center; justify-content: center; }
          .dd-facet-content { display: none; }
          .dd-facets.is-mobile-open .dd-facet-content { display: block; margin-top: 14px; }
          .dd-select-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .dd-results { overflow: visible; }
          .dd-tools { position: sticky; top: 0; padding: 13px max(14px, env(safe-area-inset-right, 0px)) 11px max(14px, env(safe-area-inset-left, 0px)); }
          .dd-results-scroll { overflow: visible; padding: 14px max(14px, env(safe-area-inset-right, 0px)) max(22px, env(safe-area-inset-bottom, 0px)) max(14px, env(safe-area-inset-left, 0px)); }
          .dd-tool-row { gap: 8px; }
          .dd-view-controls { align-items: stretch; flex-direction: column; }
          .dd-sort { width: 100%; justify-content: space-between; }
          .dd-sort select { min-width: 138px; }
          .dd-grouping { width: 100%; }
          .dd-grouping button { flex: 1 1 50%; min-height: 44px; }
          .dd-card { padding: 15px 13px; border-radius: 15px; }
          .dd-card-head { gap: 9px; }
          .dd-rank { width: 31px; height: 31px; }
          .dd-metadata, .dd-provenance, .dd-snippet, .dd-card-foot { margin-left: 40px; }
          .dd-card-foot > div { flex-basis: 100%; }
          .dd-empty { min-height: 260px; }
        }

        @media (max-width: 430px) {
          .dd-select-grid { grid-template-columns: 1fr; }
          .dd-family > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .dd-family button { width: 100%; }
          .dd-card h3, .dd-card h4 { font-size: 1.08rem; }
          .dd-metadata, .dd-provenance, .dd-snippet, .dd-card-foot { margin-left: 0; }
          .dd-card-foot { align-items: flex-start; flex-direction: column; }
        }

        @media (max-width: 350px) {
          .dd-dialog-head { gap: 8px; }
          .dd-orbit { width: 38px; height: 38px; }
          .dd-close { width: 44px; min-width: 44px; }
          .dd-family > div { grid-template-columns: 1fr; }
          .dd-view-controls { align-items: stretch; }
          .dd-sort { align-items: stretch; flex-direction: column; }
          .dd-sort select { width: 100%; }
        }

        @media (max-height: 500px) and (orientation: landscape) {
          .dd-dialog { top: 50%; bottom: auto; width: calc(100vw - max(12px, env(safe-area-inset-left, 0px)) - max(12px, env(safe-area-inset-right, 0px))); height: calc(100dvh - max(10px, env(safe-area-inset-top, 0px)) - max(10px, env(safe-area-inset-bottom, 0px))); transform: translate(-50%, -50%); border: 1px solid color-mix(in srgb, var(--p-gold) 22%, var(--border-hair)); border-radius: 18px; animation-name: ddArrive; }
          .dd-dialog-head { gap: 10px; padding: 9px 13px; }
          .dd-orbit { width: 38px; height: 38px; }
          .dd-heading-copy > p:last-child, .dd-total-pill { display: none; }
          .dd-heading-copy h2 { font-size: 1.55rem; }
          .dd-dialog-body { display: grid; grid-template-columns: minmax(220px, 250px) minmax(0, 1fr); overflow: hidden; }
          .dd-facets { overflow-x: hidden; overflow-y: auto; padding: 11px 13px max(11px, env(safe-area-inset-bottom, 0px)); border-right: 1px solid var(--border-hair); border-bottom: 0; }
          .dd-facet-heading { margin-bottom: 9px; }
          .dd-family { margin-bottom: 9px; }
          .dd-family > div { display: flex; }
          .dd-family button { width: auto; min-height: 44px; }
          .dd-select-grid { grid-template-columns: 1fr; gap: 8px; }
          .dd-results { overflow: hidden; }
          .dd-tools { position: relative; padding: 9px 12px 8px; }
          .dd-search input { min-height: 44px; }
          .dd-tool-row { align-items: center; flex-direction: row; margin-top: 6px; }
          .dd-status { font-size: 0.66rem; }
          .dd-view-controls { width: auto; align-items: center; flex-direction: row; }
          .dd-sort { width: auto; align-items: center; flex-direction: row; }
          .dd-sort > span { display: none; }
          .dd-sort select { width: auto; min-width: 108px; }
          .dd-grouping { width: auto; }
          .dd-grouping button { flex: 0 0 auto; }
          .dd-results-scroll { overflow-x: hidden; overflow-y: auto; padding: 10px 12px max(12px, env(safe-area-inset-bottom, 0px)); }
        }

        @keyframes ddRise { from { opacity: 0; transform: translateY(26px); } to { opacity: 1; transform: translateY(0); } }

        @media (prefers-reduced-motion: reduce) {
          .dd-scrim, .dd-dialog, .dd-orbit span { animation: none !important; }
          .dd-close, .dd-family button { transition: none !important; }
          .dd-close:hover, .dd-family button:hover { transform: none; }
        }
      `}</style>
    </div>
  ) : null;

  return (
    <>
      <section className="dd-launch" aria-label="Additional passages retrieved in this search">
        <div className="dd-launch-glow" aria-hidden="true" />
        <div className="dd-orbit-launch" aria-hidden="true">
          <span>✦</span>
        </div>
        <div className="dd-launch-copy">
          <p>Beyond the woven answer</p>
          <h3>Follow another thread</h3>
          <span>
            {trueTotal.toLocaleString("en-US")} more {trueTotal === 1 ? "passage" : "passages"} retrieved in this search
          </span>
        </div>
        <button
          ref={triggerRef}
          type="button"
          onClick={openDialog}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
        >
          <span>Dig deeper</span>
          <span aria-hidden="true">↗</span>
        </button>
      </section>

      <style jsx>{`
        .dd-launch, .dd-launch * { box-sizing: border-box; }
        .dd-launch { position: relative; isolation: isolate; display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: clamp(14px, 2.4vw, 24px); margin: var(--space-7, 48px) 0 0; padding: clamp(18px, 3vw, 28px); overflow: hidden; border: 1px solid color-mix(in srgb, var(--p-gold) 25%, var(--border-hair)); border-radius: 22px; color: var(--ink); background: linear-gradient(112deg, color-mix(in srgb, var(--accent-tint) 46%, var(--surface-raised)), color-mix(in srgb, var(--surface-raised) 98%, transparent) 56%, color-mix(in srgb, var(--p-gold) 12%, var(--surface-raised))); box-shadow: 0 18px 50px color-mix(in srgb, var(--ink-strong) 6%, transparent); font-family: var(--font-body), 'DM Sans', system-ui, sans-serif; }
        .dd-launch::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none; background-image: radial-gradient(circle at 8% 30%, color-mix(in srgb, var(--accent) 8%, transparent) 0 1px, transparent 1.5px), radial-gradient(circle at 91% 70%, color-mix(in srgb, var(--p-gold) 12%, transparent) 0 1px, transparent 1.5px); background-size: 24px 24px, 30px 30px; mask-image: linear-gradient(90deg, black, transparent 42%, transparent 58%, black); }
        .dd-launch-glow { position: absolute; z-index: -1; width: 260px; height: 260px; right: -130px; top: -150px; border-radius: 50%; pointer-events: none; background: radial-gradient(circle, color-mix(in srgb, var(--p-gold) 18%, transparent), transparent 68%); }
        .dd-orbit-launch { position: relative; display: grid; width: clamp(54px, 7vw, 68px); height: clamp(54px, 7vw, 68px); place-items: center; border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent); border-radius: 50%; color: var(--accent-strong); background: color-mix(in srgb, var(--surface-raised) 72%, transparent); box-shadow: 0 0 0 8px color-mix(in srgb, var(--accent) 5%, transparent); }
        .dd-orbit-launch::before, .dd-orbit-launch::after { content: ''; position: absolute; inset: 8px -6px; border: 1px solid color-mix(in srgb, var(--p-gold) 38%, transparent); border-radius: 50%; transform: rotate(55deg); }
        .dd-orbit-launch::after { transform: rotate(-55deg); }
        .dd-orbit-launch span { font-size: 19px; animation: ddLaunchBreathe 4s ease-in-out infinite; }
        .dd-launch-copy { min-width: 0; }
        .dd-launch-copy p { margin: 0 0 3px; color: var(--accent-strong); font-size: 0.66rem; font-weight: 750; letter-spacing: 0.13em; text-transform: uppercase; overflow-wrap: anywhere; }
        .dd-launch-copy h3 { margin: 0; color: var(--ink-strong); font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: clamp(1.35rem, 3vw, 1.85rem); font-weight: 550; line-height: 1.12; overflow-wrap: anywhere; }
        .dd-launch-copy > span { display: block; margin-top: 5px; color: var(--ink-muted); font-size: 0.78rem; line-height: 1.4; overflow-wrap: anywhere; }
        .dd-launch > button { display: inline-flex; min-width: 138px; min-height: 48px; align-items: center; justify-content: center; gap: 8px; padding: 9px 17px; border: 1px solid color-mix(in srgb, var(--accent) 54%, var(--p-gold)); border-radius: 999px; color: var(--surface-raised); background: linear-gradient(135deg, var(--accent), var(--accent-strong)); box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 22%, transparent); font: inherit; font-size: 0.8rem; font-weight: 750; cursor: pointer; transition: transform var(--dur-2) var(--ease-standard), box-shadow var(--dur-2) var(--ease-standard); }
        .dd-launch > button:hover { transform: translateY(-2px); box-shadow: 0 12px 28px color-mix(in srgb, var(--accent) 28%, transparent); }
        .dd-launch > button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent-strong) 78%, white); outline-offset: 3px; }
        @keyframes ddLaunchBreathe { 0%, 100% { opacity: 0.72; transform: scale(0.9) rotate(0deg); } 50% { opacity: 1; transform: scale(1.12) rotate(18deg); } }
        @media (max-width: 600px) {
          .dd-launch { grid-template-columns: auto minmax(0, 1fr); padding: 17px 15px; border-radius: 18px; }
          .dd-launch > button { grid-column: 1 / -1; width: 100%; min-height: 48px; }
          .dd-orbit-launch { width: 50px; height: 50px; }
        }
        @media (max-width: 350px) {
          .dd-launch { gap: 11px; }
          .dd-orbit-launch { width: 44px; height: 44px; }
          .dd-launch-copy h3 { font-size: 1.25rem; }
        }
        @media (prefers-reduced-motion: reduce) {
          .dd-orbit-launch span { animation: none; }
          .dd-launch > button { transition: none; }
          .dd-launch > button:hover { transform: none; }
        }
      `}</style>

      {modal ? createPortal(modal, document.body) : null}
    </>
  );
}
