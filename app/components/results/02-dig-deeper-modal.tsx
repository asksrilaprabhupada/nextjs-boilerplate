/**
 * 02-dig-deeper-modal.tsx — Dig Deeper Sheet
 *
 * Overflow browser showing ALL search results beyond the woven essay. Presented
 * as a right-side drawer on desktop and a full-height sheet on mobile
 * (sacred-minimalism: warm neutrals, one soft-violet accent, no per-source
 * colors). Features: count-chip content-type filters, Relevance|Date sort,
 * search-within-results, group mode toggle
 * (Ranked / By Topic / By Book), multi-select book dropdown, per-type cards
 * with purport/context expanders, copy-with-reference, "Ask about this
 * passage", an honest "Showing X of Y" line, URL-hash state (#deeper=<type>),
 * and a focus-trapped dialog (Esc closes).
 */
"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { VerseHit, ProseHit, TranscriptHit, LetterHit } from "./01-narrative-response";
import { getBookName } from "@/app/lib/12-provenance";
import {
  type PassageLabel,
  labelForVerse,
  labelForProse,
  labelForTranscript,
} from "@/app/lib/13-passage-label";

/**
 * Quiet TYPE/SPEAKER + provenance line under a card's ref chip. The chip
 * already names the source, so the source segment (parts[0]) is dropped.
 */
function ProvenanceLine({ label }: { label: PassageLabel }) {
  const text = label.parts.slice(1).filter(Boolean).join(" · ");
  if (!text && !label.provenanceNote) return null;
  return (
    <div className="passage-label" style={{ marginBottom: 6 }}>
      {text && <span>{text}</span>}
      {label.provenanceNote && <span className="passage-label-note">{label.provenanceNote}</span>}
    </div>
  );
}

/* ─── Neutral chip styling (sacred minimalism — no per-book color) ─── */
const NEUTRAL_CHIP = {
  bg: "var(--accent-tint)",
  text: "var(--accent-strong)",
  border: "var(--border-hair)",
} as const;

// Every card/tag uses the single soft-violet accent chip regardless of source.
function getBookColor(_slug?: string) {
  void _slug;
  return NEUTRAL_CHIP;
}

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text || "";
  const cut = text.substring(0, max);
  const lp = cut.lastIndexOf(".");
  return lp > max * 0.5 ? cut.substring(0, lp + 1) : cut + "...";
}

/** Extract SUMMARY tag text from tags array */
function getTagSummary(tags: string[] | null | undefined): string | null {
  if (!tags) return null;
  const summary = tags.find(t => t.startsWith("SUMMARY:"));
  return summary ? summary.replace("SUMMARY:", "").trim() : null;
}

/** Group verses by their primary topic tag */
function groupByTopic(verses: VerseHit[]): Map<string, VerseHit[]> {
  const groups = new Map<string, VerseHit[]>();
  for (const v of verses) {
    const topics = (v.tags || []).filter(t =>
      !t.startsWith("SUMMARY:") && !t.includes("?") &&
      t.length > 2 && t.length < 40 && /^[a-zA-Z\s]+$/.test(t)
    );
    const theme = topics[0]
      ? topics[0].charAt(0).toUpperCase() + topics[0].slice(1)
      : "Other";
    if (!groups.has(theme)) groups.set(theme, []);
    groups.get(theme)!.push(v);
  }
  return groups;
}

/** Group verses by book name */
function groupByBook(verses: VerseHit[]): Map<string, VerseHit[]> {
  const groups = new Map<string, VerseHit[]>();
  for (const v of verses) {
    const name = getBookName(v.book_slug || v.scripture?.toLowerCase() || "");
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(v);
  }
  return groups;
}

/** Case-insensitive search-within-results match over a card's visible text. */
function matchesSearch(needle: string, ...haystacks: (string | undefined)[]): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return haystacks.some(h => (h || "").toLowerCase().includes(n));
}

/** Newest-first by date; undated items keep their relative order at the end. */
function sortByDate<T extends { date?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : NaN;
    const db = b.date ? Date.parse(b.date) : NaN;
    if (Number.isNaN(da) && Number.isNaN(db)) return 0;
    if (Number.isNaN(da)) return 1;
    if (Number.isNaN(db)) return -1;
    return db - da;
  });
}

type ContentType = "all" | "verses" | "prose" | "lectures" | "letters";
type GroupMode = "flat" | "topic" | "book";
type SortMode = "relevance" | "date";

const HASH_PREFIX = "#deeper";

interface DigDeeperProps {
  overflowVerses: VerseHit[];
  overflowProse: ProseHit[];
  overflowTranscripts?: TranscriptHit[];
  overflowLetters?: LetterHit[];
  totalVerses: number;
  totalProse: number;
  totalTranscripts?: number;
  totalLetters?: number;
  articleVerseIds?: Set<string>;
  onClose: () => void;
  /** Seeds a fresh search from a passage ("Ask about this passage"). */
  onSearch?: (q: string) => void;
}

/* ─── Segmented Toggle (reusable) ─── */
function SegmentedToggle<T extends string>({ options, value, onChange }: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
      {options.map((opt, i) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className="font-body"
          style={{
            padding: "6px 12px", fontSize: 12, fontWeight: 500, border: "none",
            borderLeft: i > 0 ? "1px solid var(--border-hair)" : "none",
            background: value === opt.key ? "var(--accent)" : "transparent",
            color: value === opt.key ? "var(--surface-raised)" : "var(--ink-muted)",
            cursor: "pointer", transition: "background 0.15s ease, color 0.15s ease",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ─── Multi-select Book Dropdown ─── */
function BookDropdown({ books, selectedBooks, onSelectionChange }: {
  books: { name: string; count: number }[];
  selectedBooks: Set<string>;
  onSelectionChange: (s: Set<string>) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setIsOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleBook = (name: string) => {
    const next = new Set(selectedBooks);
    if (next.has(name)) next.delete(name); else next.add(name);
    onSelectionChange(next);
  };

  const totalCount = books.reduce((sum, b) => sum + b.count, 0);
  const label = selectedBooks.size === 0 ? "All books" : selectedBooks.size === 1 ? [...selectedBooks][0] : `${selectedBooks.size} books selected`;

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="font-body"
        style={{
          padding: "6px 12px", fontSize: 13, color: "var(--ink)", background: "transparent",
          border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 6, minWidth: 180, justifyContent: "space-between",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" style={{ flexShrink: 0, transition: "transform 0.2s ease", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}>
          <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {isOpen && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 280,
          background: "var(--surface-raised)", border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)", zIndex: 10,
          maxHeight: 280, overflowY: "auto", transformOrigin: "top",
          animation: "dropdownIn 0.15s ease-out",
          boxShadow: "var(--shadow-soft)",
        }}>
          {/* All books option */}
          <div
            onClick={() => { onSelectionChange(new Set()); setIsOpen(false); }}
            className="font-body"
            style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--accent-tint)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ fontWeight: selectedBooks.size === 0 ? 600 : 400 }}>All books</span>
            <span style={{ fontSize: 12, color: "var(--ink-subtle)" }}>{totalCount}</span>
          </div>
          <div style={{ height: 1, background: "var(--border-hair)", margin: "4px 0" }} />

          {books.map(book => {
            const isSelected = selectedBooks.has(book.name);
            return (
              <div
                key={book.name}
                onClick={() => toggleBook(book.name)}
                className="font-body"
                style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background 0.1s ease" }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--accent-tint)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    {isSelected ? (
                      <>
                        <rect width="14" height="14" rx="3" fill="var(--accent)" />
                        <path d="M4 7l2 2 4-4" fill="none" stroke="var(--surface-raised)" strokeWidth="1.5" strokeLinecap="round" />
                      </>
                    ) : (
                      <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="none" stroke="var(--border-hair)" />
                    )}
                  </svg>
                  {book.name}
                </span>
                <span style={{ fontSize: 12, color: "var(--ink-subtle)" }}>{book.count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Shared card bits: expander + action row ─── */

/** Small in-card expander ("Purport ▸" / "Show context ▸") — verbatim content only. */
function ExpandBlock({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 6 }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="font-body"
        style={{ background: "none", border: "none", padding: 0, fontSize: 12, fontWeight: 600, color: "var(--accent-strong)", cursor: "pointer" }}
      >
        {open ? `${label.replace("▸", "▾")}` : label}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22 }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ paddingTop: 8 }}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Before/after neighbour paragraphs, dimmed around the matched one. */
function ContextBlock({ before, after, body }: { before?: string; after?: string; body: string }) {
  return (
    <div className="font-body" style={{ fontSize: 13, lineHeight: 1.7, color: "var(--ink-muted)", borderLeft: "2px solid var(--border-hair)", paddingLeft: 12 }}>
      {before && <p style={{ margin: "0 0 8px", opacity: 0.75 }}>{before}</p>}
      <p style={{ margin: "0 0 8px", color: "var(--ink)" }}>{body}</p>
      {after && <p style={{ margin: 0, opacity: 0.75 }}>{after}</p>}
    </div>
  );
}

/** Ask-about + copy actions under a card. */
function CardActions({ askQuery, onSearch, copyText }: {
  askQuery: string;
  onSearch?: (q: string) => void;
  copyText?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!onSearch && !copyText) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8 }}>
      {onSearch && (
        <button
          onClick={() => onSearch(askQuery)}
          className="font-body"
          style={{ background: "none", border: "none", padding: 0, fontSize: 12, fontWeight: 600, color: "var(--accent-strong)", cursor: "pointer" }}
        >
          Ask about this passage
        </button>
      )}
      {copyText && (
        <button
          onClick={async () => {
            try { await navigator.clipboard.writeText(copyText); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard unavailable */ }
          }}
          className="font-body"
          style={{ background: "none", border: "none", padding: 0, fontSize: 12, fontWeight: 500, color: "var(--ink-muted)", cursor: "pointer" }}
        >
          {copied ? "Copied ✓" : "Copy with reference"}
        </button>
      )}
    </div>
  );
}

/** First ~8 words of a passage, for seeding "Ask about this passage". */
function seedFromBody(text: string): string {
  return (text || "").split(/\s+/).slice(0, 8).join(" ");
}

/* ─── Single verse card ─── */
function VerseCard({ v, index, articleVerseIds, onSearch }: { v: VerseHit; index: number; articleVerseIds?: Set<string>; onSearch?: (q: string) => void }) {
  const ref = `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number ? v.chapter_number + "." : ""}${v.verse_number}`;
  const slug = v.book_slug || v.scripture?.toLowerCase() || "";
  const colors = getBookColor(slug);
  const summary = getTagSummary(v.tags);
  const inArticle = articleVerseIds?.has(v.id);
  const purport = (v.purport || "").trim();

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.03, 0.6) }}
      style={{ marginBottom: 20 }}
    >
      <div style={{
        padding: "16px 20px", background: "var(--surface-raised)",
        borderLeft: `3px solid ${colors.border}`,
        borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <span className="font-body" style={{
            display: "inline-block", fontSize: 11, fontWeight: 500,
            padding: "2px 8px", borderRadius: "var(--radius-sm)",
            background: colors.bg, color: colors.text,
          }}>
            {ref}
          </span>
          {v.speaker && (
            <span className="font-body" style={{
              fontSize: 10, color: "var(--p-gold, #8A5A0B)",
              padding: "2px 8px", borderRadius: 6, border: "1px solid var(--border-hair)",
            }}>
              {v.speaker}{v.speakerTo ? ` → ${v.speakerTo}` : ""}
            </span>
          )}
          {inArticle && (
            <span className="font-body" style={{
              fontSize: 10, color: "var(--accent-strong)", background: "var(--accent-tint)",
              padding: "2px 8px", borderRadius: 6,
            }}>
              In article
            </span>
          )}
        </div>
        <ProvenanceLine label={labelForVerse(v)} />
        <p style={{
          fontSize: 16, lineHeight: 1.8, fontStyle: "italic",
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "var(--ink)", margin: "0 0 8px",
        }}>
          &ldquo;{truncate(v.translation, 200)}&rdquo;
        </p>
        {summary && (
          <p className="font-body" style={{
            fontSize: 12, color: "var(--ink-muted)", marginTop: 4, marginBottom: 8,
            fontStyle: "italic", lineHeight: 1.5,
          }}>
            {summary}
          </p>
        )}
        {purport && (
          <ExpandBlock label="Purport ▸">
            <div className="font-body" style={{ fontSize: 13, lineHeight: 1.7, color: "var(--ink)", borderLeft: "2px solid var(--border-hair)", paddingLeft: 12, whiteSpace: "pre-line" }}>
              {purport}
            </div>
          </ExpandBlock>
        )}
        <CardActions
          askQuery={ref}
          onSearch={onSearch}
          copyText={`"${v.translation}" — ${ref}${v.vedabase_url ? `\n${v.vedabase_url}` : ""}`}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
          {v.chapter_title && (
            <p className="font-body" style={{ fontSize: 12, color: "var(--ink-muted)", margin: 0 }}>{v.chapter_title}</p>
          )}
          {v.vedabase_url && (
            <a href={v.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "var(--accent-strong)", textDecoration: "none", fontWeight: 500, marginLeft: "auto" }}
              onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; }}
            >
              Open on Vedabase &#8599;
            </a>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Single prose card ─── */
function ProseCard({ p, index, onSearch }: { p: ProseHit; index: number; onSearch?: (q: string) => void }) {
  const slug = p.book_slug || "";
  const colors = getBookColor(slug);
  const summary = getTagSummary(p.tags);
  const bookName = getBookName(p.book_slug);
  const hasContext = !!(p.before || p.after);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.03, 0.6) }}
      style={{ marginBottom: 20 }}
    >
      <div style={{
        padding: "16px 20px", background: "var(--surface-raised)",
        borderLeft: `3px solid ${colors.border}`,
        borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
      }}>
        <span className="font-body" style={{
          display: "inline-block", fontSize: 11, fontWeight: 500,
          padding: "2px 8px", borderRadius: "var(--radius-sm)", marginBottom: 8,
          background: colors.bg, color: colors.text,
        }}>
          {bookName}
        </span>
        <ProvenanceLine label={labelForProse(p)} />
        <p style={{
          fontSize: 16, lineHeight: 1.8, fontStyle: "italic",
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "var(--ink)", margin: "0 0 8px",
        }}>
          {truncate(p.body_text, 200)}
        </p>
        {summary && (
          <p className="font-body" style={{
            fontSize: 12, color: "var(--ink-muted)", marginTop: 4, marginBottom: 8,
            fontStyle: "italic", lineHeight: 1.5,
          }}>
            {summary}
          </p>
        )}
        {hasContext && (
          <ExpandBlock label="Show context ▸">
            <ContextBlock before={p.before} after={p.after} body={p.body_text} />
          </ExpandBlock>
        )}
        <CardActions
          askQuery={seedFromBody(p.body_text)}
          onSearch={onSearch}
          copyText={`"${p.body_text}" — ${bookName}${p.vedabase_url ? `\n${p.vedabase_url}` : ""}`}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
          {p.chapter_title && (
            <p className="font-body" style={{ fontSize: 12, color: "var(--ink-muted)", margin: 0 }}>{p.chapter_title}</p>
          )}
          {p.vedabase_url && (
            <a href={p.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "var(--accent-strong)", textDecoration: "none", fontWeight: 500, marginLeft: "auto" }}
              onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; }}
            >
              Read on Vedabase &#8599;
            </a>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Single transcript (lecture) card ─── */
function TranscriptCard({ t, index, onSearch }: { t: TranscriptHit; index: number; onSearch?: (q: string) => void }) {
  const colors = getBookColor();
  const summary = getTagSummary(t.tags);
  const datePart = t.date ? new Date(t.date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
  const kind = labelForTranscript(t).parts[0];
  const label = [t.title, datePart, t.location].filter(Boolean).join(" · ") || kind;
  const hasContext = !!(t.before || t.after);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.03, 0.6) }}
      style={{ marginBottom: 20 }}
    >
      <div style={{
        padding: "16px 20px", background: "var(--surface-raised)",
        borderLeft: `3px solid ${colors.border}`,
        borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
      }}>
        <span className="font-body" style={{
          display: "inline-block", fontSize: 11, fontWeight: 500,
          padding: "2px 8px", borderRadius: "var(--radius-sm)", marginBottom: 8,
          background: colors.bg, color: colors.text,
        }}>
          {kind}
        </span>
        <p className="font-body" style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 6, fontStyle: "italic" }}>{label}</p>
        <p style={{
          fontSize: 16, lineHeight: 1.8, fontStyle: "italic",
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "var(--ink)", margin: "0 0 8px",
        }}>
          {truncate(t.body_text, 200)}
        </p>
        {summary && (
          <p className="font-body" style={{
            fontSize: 12, color: "var(--ink-muted)", marginTop: 4, marginBottom: 8,
            fontStyle: "italic", lineHeight: 1.5,
          }}>
            {summary}
          </p>
        )}
        {hasContext && (
          <ExpandBlock label="Show context ▸">
            <ContextBlock before={t.before} after={t.after} body={t.body_text} />
          </ExpandBlock>
        )}
        <CardActions
          askQuery={seedFromBody(t.body_text)}
          onSearch={onSearch}
          copyText={`"${t.body_text}" — ${label}${t.vedabase_url ? `\n${t.vedabase_url}` : ""}`}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: 6 }}>
          {t.vedabase_url && (
            <a href={t.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "var(--accent-strong)", textDecoration: "none", fontWeight: 500 }}
              onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; }}
            >
              Open on Vedabase &#8599;
            </a>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Single letter card ─── */
function LetterCard({ l, index, onSearch }: { l: LetterHit; index: number; onSearch?: (q: string) => void }) {
  const colors = getBookColor();
  const summary = getTagSummary(l.tags);
  const datePart = l.date ? new Date(l.date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
  const label = [l.recipient ? `To ${l.recipient}` : "", datePart].filter(Boolean).join(" · ") || "Letter";
  const hasContext = !!(l.before || l.after);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.03, 0.6) }}
      style={{ marginBottom: 20 }}
    >
      <div style={{
        padding: "16px 20px", background: "var(--surface-raised)",
        borderLeft: `3px solid ${colors.border}`,
        borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
      }}>
        <span className="font-body" style={{
          display: "inline-block", fontSize: 11, fontWeight: 500,
          padding: "2px 8px", borderRadius: "var(--radius-sm)", marginBottom: 8,
          background: colors.bg, color: colors.text,
        }}>
          Letter
        </span>
        <p className="font-body" style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 6, fontStyle: "italic" }}>{label}</p>
        <p style={{
          fontSize: 16, lineHeight: 1.8, fontStyle: "italic",
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "var(--ink)", margin: "0 0 8px",
        }}>
          {truncate(l.body_text, 200)}
        </p>
        {summary && (
          <p className="font-body" style={{
            fontSize: 12, color: "var(--ink-muted)", marginTop: 4, marginBottom: 8,
            fontStyle: "italic", lineHeight: 1.5,
          }}>
            {summary}
          </p>
        )}
        {hasContext && (
          <ExpandBlock label="Show context ▸">
            <ContextBlock before={l.before} after={l.after} body={l.body_text} />
          </ExpandBlock>
        )}
        <CardActions
          askQuery={seedFromBody(l.body_text)}
          onSearch={onSearch}
          copyText={`"${l.body_text}" — ${label}${l.vedabase_url ? `\n${l.vedabase_url}` : ""}`}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginTop: 6 }}>
          {l.vedabase_url && (
            <a href={l.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "var(--accent-strong)", textDecoration: "none", fontWeight: 500 }}
              onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; }}
            >
              Open on Vedabase &#8599;
            </a>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Collapsible topic/book group ─── */
function CollapsibleGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="font-body"
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "10px 0", background: "transparent", border: "none",
          cursor: "pointer", fontSize: 14, fontWeight: 600, color: "var(--ink)",
          borderBottom: "1px solid var(--border-hair)",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" style={{ transition: "transform 0.2s ease", transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}>
          <path d="M4 2l5 4-5 4" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {title}
        <span style={{ fontSize: 11, color: "var(--ink-muted)", fontWeight: 400 }}>({count})</span>
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            style={{ overflow: "hidden", paddingTop: 8 }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Reads the initial type filter from a #deeper=<type> hash (browser back/deep link). */
function initialTypeFromHash(): ContentType {
  if (typeof window === "undefined") return "all";
  const h = window.location.hash;
  if (!h.startsWith(HASH_PREFIX)) return "all";
  const value = h.slice(HASH_PREFIX.length + 1); // strip "#deeper="
  return (["verses", "prose", "lectures", "letters"] as const).includes(value as Exclude<ContentType, "all">)
    ? (value as ContentType)
    : "all";
}

export default function DigDeeperModal({ overflowVerses, overflowProse, overflowTranscripts = [], overflowLetters = [], totalVerses, totalProse, totalTranscripts = 0, totalLetters = 0, articleVerseIds, onClose, onSearch }: DigDeeperProps) {
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<ContentType>(initialTypeFromHash);
  const [groupMode, setGroupMode] = useState<GroupMode>("flat");
  const [sortMode, setSortMode] = useState<SortMode>("relevance");
  const [searchWithin, setSearchWithin] = useState("");

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  /* Track viewport to switch between right-side drawer (desktop) and full-height sheet (mobile). */
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  /* Esc closes + focus trap: focus lands on the close button, Tab cycles inside
     the dialog, and focus returns to the opener on close. */
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKey);
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKey);
      opener?.focus?.();
    };
  }, [handleKey]);

  /* URL-hash state: open ↔ #deeper[=<type>], kept in sync with the type filter
     (replaceState — no history spam); browser Back (hash removal) closes. */
  useEffect(() => {
    const hash = typeFilter === "all" ? HASH_PREFIX : `${HASH_PREFIX}=${typeFilter}`;
    try { history.replaceState(null, "", `${location.pathname}${location.search}${hash}`); } catch { /* sandboxed */ }
    return () => {
      if (location.hash.startsWith(HASH_PREFIX)) {
        try { history.replaceState(null, "", `${location.pathname}${location.search}`); } catch { /* sandboxed */ }
      }
    };
  }, [typeFilter]);

  useEffect(() => {
    const onHashChange = () => { if (!location.hash.startsWith(HASH_PREFIX)) onClose(); };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [onClose]);

  /* Extract unique books with counts */
  const bookCounts = useMemo(() => {
    const counts = new Map<string, number>();
    overflowVerses.forEach(v => {
      const name = getBookName(v.book_slug || v.scripture?.toLowerCase() || "");
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    overflowProse.forEach(p => {
      const name = getBookName(p.book_slug || "");
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    if (overflowTranscripts.length > 0) counts.set("Lectures", overflowTranscripts.length);
    if (overflowLetters.length > 0) counts.set("Letters", overflowLetters.length);
    return counts;
  }, [overflowVerses, overflowProse, overflowTranscripts, overflowLetters]);

  const books = useMemo(() =>
    Array.from(bookCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    [bookCounts]
  );

  /* Apply filters: type · book · search-within */
  const filteredVerses = useMemo(() => overflowVerses.filter(v => {
    if (typeFilter !== "all" && typeFilter !== "verses") return false;
    if (!matchesSearch(searchWithin, v.translation, v.purport, v.chapter_title, v.scripture, v.verse_number)) return false;
    if (selectedBooks.size === 0) return true;
    return selectedBooks.has(getBookName(v.book_slug || v.scripture?.toLowerCase() || ""));
  }), [overflowVerses, typeFilter, selectedBooks, searchWithin]);

  const filteredProse = useMemo(() => overflowProse.filter(p => {
    if (typeFilter !== "all" && typeFilter !== "prose") return false;
    if (!matchesSearch(searchWithin, p.body_text, p.chapter_title, getBookName(p.book_slug))) return false;
    if (selectedBooks.size === 0) return true;
    return selectedBooks.has(getBookName(p.book_slug || ""));
  }), [overflowProse, typeFilter, selectedBooks, searchWithin]);

  const filteredTranscripts = useMemo(() => {
    const base = overflowTranscripts.filter(t => {
      if (typeFilter !== "all" && typeFilter !== "lectures") return false;
      if (!matchesSearch(searchWithin, t.body_text, t.title, t.location)) return false;
      if (selectedBooks.size === 0) return true;
      return selectedBooks.has("Lectures");
    });
    return sortMode === "date" ? sortByDate(base) : base;
  }, [overflowTranscripts, typeFilter, selectedBooks, searchWithin, sortMode]);

  const filteredLetters = useMemo(() => {
    const base = overflowLetters.filter(l => {
      if (typeFilter !== "all" && typeFilter !== "letters") return false;
      if (!matchesSearch(searchWithin, l.body_text, l.recipient)) return false;
      if (selectedBooks.size === 0) return true;
      return selectedBooks.has("Letters");
    });
    return sortMode === "date" ? sortByDate(base) : base;
  }, [overflowLetters, typeFilter, selectedBooks, searchWithin, sortMode]);

  /* Grouped data */
  const topicGroups = useMemo(() => groupByTopic(filteredVerses), [filteredVerses]);
  const bookGroups = useMemo(() => groupByBook(filteredVerses), [filteredVerses]);

  const renderedCount = filteredVerses.length + filteredProse.length + filteredTranscripts.length + filteredLetters.length;
  const grandTotal = totalVerses + totalProse + totalTranscripts + totalLetters;
  const hasResults = renderedCount > 0;
  const overflowSum = overflowVerses.length + overflowProse.length + overflowTranscripts.length + overflowLetters.length;

  /* Panel geometry differs by breakpoint:
     desktop → right-side drawer (slides in on x); mobile → full-height sheet (slides up on y). */
  const panelInitial = isMobile ? { opacity: 0, y: 32 } : { opacity: 0, x: 32 };
  const panelAnimate = isMobile ? { opacity: 1, y: 0 } : { opacity: 1, x: 0 };
  const panelExit = isMobile ? { opacity: 0, y: 32 } : { opacity: 0, x: 32 };

  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed", left: 0, right: 0, bottom: 0, top: 0,
        width: "100%", height: "100dvh",
        display: "flex", flexDirection: "column",
        background: "var(--surface-raised)",
        boxShadow: "var(--shadow-soft)", border: "1px solid var(--border-hair)",
      }
    : {
        position: "fixed", top: 0, right: 0, bottom: 0,
        height: "100vh", width: "min(560px, 92vw)",
        display: "flex", flexDirection: "column",
        background: "var(--surface-raised)",
        boxShadow: "var(--shadow-soft)", border: "1px solid var(--border-hair)",
      };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 300, background: "color-mix(in srgb, var(--ink-strong) 32%, transparent)", backdropFilter: "blur(8px)", display: "flex", alignItems: isMobile ? "flex-end" : "stretch", justifyContent: isMobile ? "center" : "flex-end" }}
      >
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Dig deeper — all sources"
          initial={panelInitial} animate={panelAnimate} exit={panelExit}
          transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
          onClick={e => e.stopPropagation()}
          style={panelStyle}
        >
          {/* Close button */}
          <button ref={closeBtnRef} onClick={onClose} aria-label="Close" style={{ position: "absolute", top: 12, right: 12, width: 40, height: 40, borderRadius: "var(--radius-sm)", border: "1px solid var(--border-hair)", background: "var(--surface-raised)", color: "var(--ink-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, zIndex: 2 }}>&#10005;</button>

          {/* Header */}
          <div style={{ padding: "clamp(20px, 4vw, 28px) 24px 0", flexShrink: 0 }}>
            <div style={{ marginBottom: 12 }}>
              <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--accent-strong)", marginBottom: 4 }}>
                Explore All Sources
              </p>
              <h2 className="font-display" style={{ fontSize: "1.4rem", fontWeight: 600, color: "var(--ink)", marginRight: 48 }}>
                Dig Deeper
              </h2>
              <p className="font-body" style={{ fontSize: 13, color: "var(--ink-muted)", marginTop: 4 }}>
                Showing {renderedCount} of {grandTotal} relevant passages
              </p>
            </div>

            {/* ─── Compact filter bar ─── */}
            <div style={{
              padding: "12px 0", borderBottom: "1px solid var(--border-hair)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            }}>
              {/* Content type toggle — count chips */}
              <SegmentedToggle<ContentType>
                options={[
                  { key: "all", label: `All ${overflowSum}` },
                  { key: "verses", label: `Verses ${overflowVerses.length}` },
                  { key: "prose", label: `Books ${overflowProse.length}` },
                  ...(overflowTranscripts.length > 0 ? [{ key: "lectures" as ContentType, label: `Lectures ${overflowTranscripts.length}` }] : []),
                  ...(overflowLetters.length > 0 ? [{ key: "letters" as ContentType, label: `Letters ${overflowLetters.length}` }] : []),
                ]}
                value={typeFilter}
                onChange={setTypeFilter}
              />

              {/* Divider */}
              <div style={{ width: 1, height: 24, background: "var(--border-hair)" }} />

              {/* Sort — Date applies to lectures/letters (dated sources) */}
              {(overflowTranscripts.length > 0 || overflowLetters.length > 0) && (
                <SegmentedToggle<SortMode>
                  options={[
                    { key: "relevance", label: "Relevance" },
                    { key: "date", label: "Date" },
                  ]}
                  value={sortMode}
                  onChange={setSortMode}
                />
              )}

              {/* Group mode toggle */}
              <SegmentedToggle<GroupMode>
                options={[
                  { key: "flat", label: "Ranked" },
                  { key: "topic", label: "By Topic" },
                  { key: "book", label: "By Book" },
                ]}
                value={groupMode}
                onChange={setGroupMode}
              />

              {/* Divider */}
              <div style={{ width: 1, height: 24, background: "var(--border-hair)" }} />

              {/* Book dropdown */}
              {books.length > 0 && (
                <BookDropdown books={books} selectedBooks={selectedBooks} onSelectionChange={setSelectedBooks} />
              )}

              {/* Active filter chips */}
              {selectedBooks.size > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {[...selectedBooks].map(bookName => (
                    <span
                      key={bookName}
                      onClick={() => {
                        const next = new Set(selectedBooks);
                        next.delete(bookName);
                        setSelectedBooks(next);
                      }}
                      className="font-body"
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "3px 8px", fontSize: 11, background: "var(--accent-tint)", color: "var(--accent-strong)",
                        borderRadius: "var(--radius-sm)", cursor: "pointer", transition: "background 0.15s ease",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 22%, transparent)"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "var(--accent-tint)"; }}
                    >
                      {bookName.split(" ").slice(0, 2).join(" ")}
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <path d="M3 3l4 4M7 3l-4 4" stroke="var(--accent-strong)" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* ─── Second row: search within the complete evidence ─── */}
            <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border-hair)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <input
                type="search"
                value={searchWithin}
                onChange={e => setSearchWithin(e.target.value)}
                placeholder="Search within results…"
                aria-label="Search within results"
                className="font-body"
                style={{
                  flex: "1 1 180px", minWidth: 140, padding: "6px 12px", fontSize: 13,
                  color: "var(--ink)", background: "transparent",
                  border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)", outline: "none",
                }}
              />
            </div>
          </div>

          {/* Scrollable results */}
          <div style={{ overflowY: "auto", padding: "20px 24px", flex: 1, minHeight: 0 }}>
            {!hasResults && (
              <div style={{ textAlign: "center", padding: "48px 20px" }}>
                <p className="font-body" style={{ fontSize: 14, color: "var(--ink-muted)" }}>
                  No results match your filters. Try different books, clearing the search, or showing all sources.
                </p>
              </div>
            )}

            {/* ─── Flat (Ranked) mode ─── */}
            {groupMode === "flat" && (
              <>
                {filteredVerses.map((v, i) => (
                  <VerseCard key={v.id} v={v} index={i} articleVerseIds={articleVerseIds} onSearch={onSearch} />
                ))}
                {filteredProse.map((p, i) => (
                  <ProseCard key={p.id} p={p} index={filteredVerses.length + i} onSearch={onSearch} />
                ))}
                {filteredTranscripts.map((t, i) => (
                  <TranscriptCard key={t.id} t={t} index={filteredVerses.length + filteredProse.length + i} onSearch={onSearch} />
                ))}
                {filteredLetters.map((l, i) => (
                  <LetterCard key={l.id} l={l} index={filteredVerses.length + filteredProse.length + filteredTranscripts.length + i} onSearch={onSearch} />
                ))}
              </>
            )}

            {/* ─── By Topic mode ─── */}
            {groupMode === "topic" && (
              <>
                {[...topicGroups.entries()].map(([topic, verses]) => (
                  <CollapsibleGroup key={topic} title={topic} count={verses.length}>
                    {verses.map((v, i) => (
                      <VerseCard key={v.id} v={v} index={i} articleVerseIds={articleVerseIds} onSearch={onSearch} />
                    ))}
                  </CollapsibleGroup>
                ))}
                {filteredProse.length > 0 && (
                  <CollapsibleGroup title="Prose Passages" count={filteredProse.length}>
                    {filteredProse.map((p, i) => (
                      <ProseCard key={p.id} p={p} index={i} onSearch={onSearch} />
                    ))}
                  </CollapsibleGroup>
                )}
                {filteredTranscripts.length > 0 && (
                  <CollapsibleGroup title="Lecture Passages" count={filteredTranscripts.length}>
                    {filteredTranscripts.map((t, i) => (
                      <TranscriptCard key={t.id} t={t} index={i} onSearch={onSearch} />
                    ))}
                  </CollapsibleGroup>
                )}
                {filteredLetters.length > 0 && (
                  <CollapsibleGroup title="Letter Passages" count={filteredLetters.length}>
                    {filteredLetters.map((l, i) => (
                      <LetterCard key={l.id} l={l} index={i} onSearch={onSearch} />
                    ))}
                  </CollapsibleGroup>
                )}
              </>
            )}

            {/* ─── By Book mode ─── */}
            {groupMode === "book" && (
              <>
                {[...bookGroups.entries()].map(([bookName, verses]) => (
                  <CollapsibleGroup key={bookName} title={bookName} count={verses.length}>
                    {verses.map((v, i) => (
                      <VerseCard key={v.id} v={v} index={i} articleVerseIds={articleVerseIds} onSearch={onSearch} />
                    ))}
                  </CollapsibleGroup>
                ))}
                {filteredProse.length > 0 && (
                  <CollapsibleGroup title="Prose Passages" count={filteredProse.length}>
                    {filteredProse.map((p, i) => (
                      <ProseCard key={p.id} p={p} index={i} onSearch={onSearch} />
                    ))}
                  </CollapsibleGroup>
                )}
                {filteredTranscripts.length > 0 && (
                  <CollapsibleGroup title="Lecture Passages" count={filteredTranscripts.length}>
                    {filteredTranscripts.map((t, i) => (
                      <TranscriptCard key={t.id} t={t} index={i} onSearch={onSearch} />
                    ))}
                  </CollapsibleGroup>
                )}
                {filteredLetters.length > 0 && (
                  <CollapsibleGroup title="Letter Passages" count={filteredLetters.length}>
                    {filteredLetters.map((l, i) => (
                      <LetterCard key={l.id} l={l} index={i} onSearch={onSearch} />
                    ))}
                  </CollapsibleGroup>
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
