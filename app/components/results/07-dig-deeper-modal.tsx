/**
 * 07-dig-deeper-modal.tsx — Dig Deeper Modal
 *
 * Full-screen modal showing ALL search results beyond the top 25. Features a compact
 * single-line filter bar with a segmented content-type toggle and multi-select book
 * dropdown replacing the old pill grid. Color-coded scripture cards by book.
 */
"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { VerseHit, ProseHit } from "./01-narrative-response";

const BOOK_NAMES: Record<string, string> = {
  bg: "Bhagavad Gītā As It Is", sb: "Śrīmad Bhāgavatam", cc: "Śrī Caitanya Caritāmṛta",
  noi: "Nectar of Instruction", iso: "Śrī Īśopaniṣad", bs: "Śrī Brahma-saṁhitā",
  lob: "Light of the Bhāgavata", kb: "Kṛṣṇa Book", nod: "The Nectar of Devotion",
  ssr: "The Science of Self-Realization", tlc: "Teachings of Lord Caitanya",
  tlk: "Teachings of Lord Kapila", tqk: "Teachings of Queen Kuntī",
  sc: "A Second Chance", bbd: "Beyond Birth and Death",
  bhakti: "Bhakti: The Art of Eternal Love", cat: "Civilization and Transcendence",
  josd: "The Journey of Self-Discovery", owk: "On the Way to Kṛṣṇa",
  pop: "The Path of Perfection", poy: "The Perfection of Yoga",
  pqpa: "Perfect Questions, Perfect Answers", rv: "Rāja-vidyā: The King of Knowledge",
  cabh: "Chant and Be Happy", spl: "Śrīla Prabhupāda-līlāmṛta",
  rkd: "Rāmāyaṇa", mbk: "Mahābhārata",
};

/* ─── Book color-coding system ─── */
const BOOK_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  SB:      { bg: "#EEEDFE", text: "#534AB7", border: "#AFA9EC" },
  NOI:     { bg: "#E1F5EE", text: "#0F6E56", border: "#9FE1CB" },
  CC:      { bg: "#FAECE7", text: "#993C1D", border: "#F0997B" },
  SPL:     { bg: "#FBEAF0", text: "#993556", border: "#ED93B1" },
  BG:      { bg: "#FAEEDA", text: "#854F0B", border: "#FAC775" },
  default: { bg: "#F1EFE8", text: "#5F5E5A", border: "#B4B2A9" },
};

function getBookSlugPrefix(slug: string): string {
  return slug?.toUpperCase() || "default";
}

function getBookColor(slug: string) {
  const prefix = getBookSlugPrefix(slug);
  return BOOK_COLORS[prefix] || BOOK_COLORS["default"];
}

function getBookName(slug: string): string {
  return BOOK_NAMES[slug?.toLowerCase()] || slug || "Unknown";
}

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text || "";
  const cut = text.substring(0, max);
  const lp = cut.lastIndexOf(".");
  return lp > max * 0.5 ? cut.substring(0, lp + 1) : cut + "...";
}

type ContentType = "all" | "verses" | "prose";

interface DigDeeperProps {
  overflowVerses: VerseHit[];
  overflowProse: ProseHit[];
  totalVerses: number;
  totalProse: number;
  onClose: () => void;
}

/* ─── Segmented Content Type Toggle ─── */
function ContentTypeToggle({ value, onChange }: { value: ContentType; onChange: (t: ContentType) => void }) {
  const options: { key: ContentType; label: string }[] = [
    { key: "all", label: "All" },
    { key: "verses", label: "Verses" },
    { key: "prose", label: "Prose" },
  ];
  return (
    <div style={{ display: "inline-flex", border: "1px solid rgba(0,0,0,0.12)", borderRadius: 8, overflow: "hidden" }}>
      {options.map((opt, i) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className="font-body"
          style={{
            padding: "6px 14px", fontSize: 13, fontWeight: 500, border: "none",
            borderLeft: i > 0 ? "1px solid rgba(0,0,0,0.12)" : "none",
            background: value === opt.key ? "#534AB7" : "transparent",
            color: value === opt.key ? "white" : "#666",
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
          padding: "6px 12px", fontSize: 13, color: "#1a1a1a", background: "transparent",
          border: "1px solid rgba(0,0,0,0.12)", borderRadius: 8, cursor: "pointer",
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
          background: "white", border: "1px solid rgba(0,0,0,0.12)", borderRadius: 8, zIndex: 10,
          maxHeight: 280, overflowY: "auto", transformOrigin: "top",
          animation: "dropdownIn 0.15s ease-out",
          boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
        }}>
          {/* All books option */}
          <div
            onClick={() => { onSelectionChange(new Set()); setIsOpen(false); }}
            className="font-body"
            style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
            onMouseEnter={e => { e.currentTarget.style.background = "#F8F8F8"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ fontWeight: selectedBooks.size === 0 ? 600 : 400 }}>All books</span>
            <span style={{ fontSize: 12, color: "#999" }}>{totalCount}</span>
          </div>
          <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "4px 0" }} />

          {books.map(book => {
            const isSelected = selectedBooks.has(book.name);
            return (
              <div
                key={book.name}
                onClick={() => toggleBook(book.name)}
                className="font-body"
                style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background 0.1s ease" }}
                onMouseEnter={e => { e.currentTarget.style.background = "#F8F8F8"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    {isSelected ? (
                      <>
                        <rect width="14" height="14" rx="3" fill="#534AB7" />
                        <path d="M4 7l2 2 4-4" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                      </>
                    ) : (
                      <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="none" stroke="#ccc" />
                    )}
                  </svg>
                  {book.name}
                </span>
                <span style={{ fontSize: 12, color: "#999" }}>{book.count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DigDeeperModal({ overflowVerses, overflowProse, totalVerses, totalProse, onClose }: DigDeeperProps) {
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<ContentType>("all");

  const handleKey = useCallback((e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }, [onClose]);
  useEffect(() => {
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKey);
    return () => { document.body.style.overflow = ""; window.removeEventListener("keydown", handleKey); };
  }, [handleKey]);

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
    return counts;
  }, [overflowVerses, overflowProse]);

  const books = useMemo(() =>
    Array.from(bookCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    [bookCounts]
  );

  /* Apply filters */
  const filteredVerses = useMemo(() => overflowVerses.filter(v => {
    if (typeFilter === "prose") return false;
    if (selectedBooks.size === 0) return true;
    return selectedBooks.has(getBookName(v.book_slug || v.scripture?.toLowerCase() || ""));
  }), [overflowVerses, typeFilter, selectedBooks]);

  const filteredProse = useMemo(() => overflowProse.filter(p => {
    if (typeFilter === "verses") return false;
    if (selectedBooks.size === 0) return true;
    return selectedBooks.has(getBookName(p.book_slug || ""));
  }), [overflowProse, typeFilter, selectedBooks]);

  const hasResults = filteredVerses.length + filteredProse.length > 0;
  const verseCount = filteredVerses.length;
  const proseCount = filteredProse.length;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(30,27,75,0.25)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      >
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          onClick={e => e.stopPropagation()}
          style={{
            width: "95vw", maxWidth: 820, maxHeight: "85vh", display: "flex", flexDirection: "column",
            background: "rgba(255,255,255,0.92)", backdropFilter: "blur(24px)",
            borderRadius: 12,
            boxShadow: "0 24px 80px rgba(139,92,246,0.15)", border: "1px solid rgba(255,255,255,0.7)",
            position: "relative",
          }}
        >
          {/* Close button */}
          <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, width: 40, height: 40, borderRadius: 10, border: "1px solid rgba(196,181,253,0.25)", background: "rgba(255,255,255,0.6)", color: "#6B7280", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, zIndex: 2 }}>✕</button>

          {/* Header */}
          <div style={{ padding: "clamp(20px, 4vw, 28px) 24px 0", flexShrink: 0 }}>
            <div style={{ marginBottom: 12 }}>
              <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "#7C3AED", marginBottom: 4 }}>
                Explore All Sources
              </p>
              <h2 className="font-display" style={{ fontSize: "1.4rem", fontWeight: 600, color: "#1E1B4B", marginRight: 48 }}>
                Dig Deeper
              </h2>
              <p className="font-body" style={{ fontSize: 13, color: "#6B7280", marginTop: 4 }}>
                {verseCount} verse{verseCount !== 1 ? "s" : ""} · {proseCount} prose passage{proseCount !== 1 ? "s" : ""}
              </p>
            </div>

            {/* ─── Compact filter bar: one line ─── */}
            <div style={{
              padding: "12px 0", borderBottom: "1px solid rgba(0,0,0,0.08)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            }}>
              {/* Content type segmented control */}
              <ContentTypeToggle value={typeFilter} onChange={setTypeFilter} />

              {/* Vertical divider */}
              <div style={{ width: 1, height: 24, background: "rgba(0,0,0,0.12)" }} />

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
                        padding: "3px 8px", fontSize: 11, background: "#EEEDFE", color: "#3C3489",
                        borderRadius: 8, cursor: "pointer", transition: "background 0.15s ease",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#CECBF6"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#EEEDFE"; }}
                    >
                      {bookName.split(" ").slice(0, 2).join(" ")}
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <path d="M3 3l4 4M7 3l-4 4" stroke="#3C3489" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Scrollable results */}
          <div style={{ overflowY: "auto", padding: "20px 24px", flex: 1, maxHeight: "60vh" }}>
            {!hasResults && (
              <div style={{ textAlign: "center", padding: "48px 20px" }}>
                <p className="font-body" style={{ fontSize: 14, color: "#6B7280" }}>
                  No results match your filters. Try selecting different books.
                </p>
              </div>
            )}

            {/* Verse cards — color-coded */}
            {filteredVerses.map(v => {
              const ref = `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number ? v.chapter_number + "." : ""}${v.verse_number}`;
              const slug = v.book_slug || v.scripture?.toLowerCase() || "";
              const colors = getBookColor(slug);
              return (
                <div key={v.id} style={{ marginBottom: 20 }}>
                  <div style={{
                    padding: "16px 20px", background: "#FAFAFA",
                    borderLeft: `3px solid ${colors.border}`,
                    borderRadius: "0 8px 8px 0",
                  }}>
                    <span className="font-body" style={{
                      display: "inline-block", fontSize: 11, fontWeight: 500,
                      padding: "2px 8px", borderRadius: 8, marginBottom: 8,
                      background: colors.bg, color: colors.text,
                    }}>
                      {ref}
                    </span>
                    <p style={{
                      fontSize: 16, lineHeight: 1.8, fontStyle: "italic",
                      fontFamily: "Georgia, 'Times New Roman', serif",
                      color: "#1a1a1a", margin: "0 0 8px",
                    }}>
                      &ldquo;{truncate(v.translation, 200)}&rdquo;
                    </p>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      {v.chapter_title && (
                        <p className="font-body" style={{ fontSize: 12, color: "#888", margin: 0 }}>{v.chapter_title}</p>
                      )}
                      {v.vedabase_url && (
                        <a href={v.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "#534AB7", textDecoration: "none", fontWeight: 500, marginLeft: "auto" }}
                          onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; }}
                          onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; }}
                        >
                          Open on Vedabase ↗
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Prose cards — color-coded */}
            {filteredProse.map(p => {
              const slug = p.book_slug || "";
              const colors = getBookColor(slug);
              return (
                <div key={p.id} style={{ marginBottom: 20 }}>
                  <div style={{
                    padding: "16px 20px", background: "#FAFAFA",
                    borderLeft: `3px solid ${colors.border}`,
                    borderRadius: "0 8px 8px 0",
                  }}>
                    <span className="font-body" style={{
                      display: "inline-block", fontSize: 11, fontWeight: 500,
                      padding: "2px 8px", borderRadius: 8, marginBottom: 8,
                      background: colors.bg, color: colors.text,
                    }}>
                      {getBookName(p.book_slug)}
                    </span>
                    <p style={{
                      fontSize: 16, lineHeight: 1.8, fontStyle: "italic",
                      fontFamily: "Georgia, 'Times New Roman', serif",
                      color: "#1a1a1a", margin: "0 0 8px",
                    }}>
                      {truncate(p.body_text, 200)}
                    </p>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      {p.chapter_title && (
                        <p className="font-body" style={{ fontSize: 12, color: "#888", margin: 0 }}>{p.chapter_title}</p>
                      )}
                      {p.vedabase_url && (
                        <a href={p.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "#534AB7", textDecoration: "none", fontWeight: 500, marginLeft: "auto" }}
                          onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; }}
                          onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; }}
                        >
                          Read on Vedabase ↗
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
