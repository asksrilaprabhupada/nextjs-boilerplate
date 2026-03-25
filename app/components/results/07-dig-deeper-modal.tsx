/**
 * 07-dig-deeper-modal.tsx — Dig Deeper Modal
 *
 * Full-screen modal showing ALL search results beyond the top 25, with filtering
 * by book and content type. Lets senior devotees preparing lectures browse every
 * result and filter by specific books.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
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

function getBookName(slug: string): string {
  return BOOK_NAMES[slug?.toLowerCase()] || slug || "Unknown";
}

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text || "";
  const cut = text.substring(0, max);
  const lp = cut.lastIndexOf(".");
  return lp > max * 0.5 ? cut.substring(0, lp + 1) : cut + "...";
}

interface DigDeeperProps {
  overflowVerses: VerseHit[];
  overflowProse: ProseHit[];
  totalVerses: number;
  totalProse: number;
  onClose: () => void;
}

export default function DigDeeperModal({ overflowVerses, overflowProse, totalVerses, totalProse, onClose }: DigDeeperProps) {
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<"all" | "verses" | "prose">("all");

  const handleKey = useCallback((e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }, [onClose]);
  useEffect(() => {
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKey);
    return () => { document.body.style.overflow = ""; window.removeEventListener("keydown", handleKey); };
  }, [handleKey]);

  /* Extract unique books with counts */
  const bookCounts = new Map<string, number>();
  overflowVerses.forEach(v => {
    const name = getBookName(v.book_slug || v.scripture?.toLowerCase() || "");
    bookCounts.set(name, (bookCounts.get(name) || 0) + 1);
  });
  overflowProse.forEach(p => {
    const name = getBookName(p.book_slug || "");
    bookCounts.set(name, (bookCounts.get(name) || 0) + 1);
  });

  /* Apply filters */
  const filteredVerses = overflowVerses.filter(v => {
    if (typeFilter === "prose") return false;
    if (selectedBooks.size === 0) return true;
    return selectedBooks.has(getBookName(v.book_slug || v.scripture?.toLowerCase() || ""));
  });
  const filteredProse = overflowProse.filter(p => {
    if (typeFilter === "verses") return false;
    if (selectedBooks.size === 0) return true;
    return selectedBooks.has(getBookName(p.book_slug || ""));
  });

  const hasResults = filteredVerses.length + filteredProse.length > 0;

  function toggleBook(name: string) {
    setSelectedBooks(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  const pillBase: React.CSSProperties = {
    borderRadius: 100, padding: "7px 14px", fontSize: 12, fontWeight: 600,
    border: "1px solid rgba(196,181,253,0.25)", cursor: "pointer",
    transition: "all 0.15s ease", whiteSpace: "nowrap",
  };
  const pillActive: React.CSSProperties = { ...pillBase, background: "#7C3AED", color: "#fff", borderColor: "#7C3AED" };
  const pillInactive: React.CSSProperties = { ...pillBase, background: "rgba(255,255,255,0.7)", color: "#6B7280" };

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
          style={{ width: "100%", maxWidth: 820, maxHeight: "85vh", display: "flex", flexDirection: "column", background: "rgba(255,255,255,0.92)", backdropFilter: "blur(24px)", borderRadius: "clamp(16px, 3vw, 22px)", boxShadow: "0 24px 80px rgba(139,92,246,0.15)", border: "1px solid rgba(255,255,255,0.7)", position: "relative" }}
        >
          {/* Close */}
          <button onClick={onClose} style={{ position: "absolute", top: 12, right: 12, width: 40, height: 40, borderRadius: 10, border: "1px solid rgba(196,181,253,0.25)", background: "rgba(255,255,255,0.6)", color: "#6B7280", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, zIndex: 2 }}>✕</button>

          {/* Sticky header + filters */}
          <div style={{ padding: "clamp(20px, 4vw, 32px) clamp(16px, 3.5vw, 28px) 0", flexShrink: 0 }}>
            {/* Header */}
            <div style={{ marginBottom: 16 }}>
              <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "#7C3AED", marginBottom: 4 }}>
                Explore All Sources
              </p>
              <h2 className="font-display" style={{ fontSize: "1.4rem", fontWeight: 600, color: "#1E1B4B", marginRight: 48 }}>
                Dig Deeper
              </h2>
              <p className="font-body" style={{ fontSize: 13, color: "#6B7280", marginTop: 4 }}>
                {totalVerses} verses · {totalProse} prose passages
              </p>
            </div>

            {/* Filter bar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              {/* Type filter */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(["all", "verses", "prose"] as const).map(t => (
                  <button key={t} onClick={() => setTypeFilter(t)} style={typeFilter === t ? pillActive : pillInactive}>
                    {t === "all" ? "All" : t === "verses" ? "Verses" : "Prose"}
                  </button>
                ))}
              </div>
              {/* Book filter */}
              {bookCounts.size > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={() => setSelectedBooks(new Set())} style={selectedBooks.size === 0 ? pillActive : pillInactive}>
                    All Books
                  </button>
                  {Array.from(bookCounts.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => (
                    <button key={name} onClick={() => toggleBook(name)} style={selectedBooks.has(name) ? pillActive : pillInactive}>
                      {name} ({count})
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Scrollable results */}
          <div style={{ overflowY: "auto", padding: "0 clamp(16px, 3.5vw, 28px) clamp(20px, 4vw, 32px)", flex: 1 }}>
            {!hasResults && (
              <div style={{ textAlign: "center", padding: "48px 20px" }}>
                <p className="font-body" style={{ fontSize: 14, color: "#6B7280" }}>
                  No results match your filters. Try selecting different books.
                </p>
              </div>
            )}

            {/* Verse cards */}
            {filteredVerses.map(v => {
              const ref = `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number ? v.chapter_number + "." : ""}${v.verse_number}`;
              return (
                <div key={v.id} style={{ marginBottom: 14 }}>
                  <div style={{ background: "rgba(245,240,255,0.5)", border: "1px solid rgba(196,181,253,0.25)", borderLeft: "3px solid #8B5CF6", padding: "16px 20px", borderRadius: 14 }}>
                    <span className="font-body" style={{ display: "inline-block", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#7C3AED", background: "rgba(139,92,246,0.08)", borderRadius: 6, padding: "2px 8px", marginBottom: 8 }}>
                      {ref}
                    </span>
                    <p className="font-display" style={{ fontSize: "0.95rem", fontStyle: "italic", lineHeight: 1.7, color: "#1E1B4B", marginBottom: 6 }}>
                      &ldquo;{truncate(v.translation, 200)}&rdquo;
                    </p>
                    {v.chapter_title && (
                      <p className="font-body" style={{ fontSize: 12, color: "#6B7280", marginBottom: 6 }}>{v.chapter_title}</p>
                    )}
                    {v.vedabase_url && (
                      <div style={{ textAlign: "right" }}>
                        <a href={v.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "#8B5CF6", textDecoration: "none", fontWeight: 600 }}>
                          Open on Vedabase ↗
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Prose cards */}
            {filteredProse.map(p => (
              <div key={p.id} style={{ marginBottom: 14, background: "rgba(245,240,255,0.3)", border: "1px solid rgba(196,181,253,0.15)", borderLeft: "3px solid #6366F1", padding: "14px 18px", borderRadius: 14 }}>
                <span className="font-body" style={{ display: "inline-block", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6366F1", background: "rgba(99,102,241,0.08)", borderRadius: 6, padding: "2px 8px", marginBottom: 8 }}>
                  {getBookName(p.book_slug)}
                </span>
                <p className="font-body" style={{ fontSize: 14, lineHeight: 1.8, color: "#374151", marginBottom: 6 }}>
                  {truncate(p.body_text, 200)}
                </p>
                {p.chapter_title && (
                  <p className="font-body" style={{ fontSize: 12, color: "#6B7280", marginBottom: 6 }}>{p.chapter_title}</p>
                )}
                {p.vedabase_url && (
                  <div style={{ textAlign: "right" }}>
                    <a href={p.vedabase_url} target="_blank" rel="noopener noreferrer" className="font-body" style={{ fontSize: 12, color: "#6366F1", textDecoration: "none", fontWeight: 500 }}>
                      Read on Vedabase ↗
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
