/**
 * 01-narrative-response.tsx — Narrative Response Layout
 *
 * Single-column search results with a compact sources header bar replacing the old 3-column layout.
 * Left rail (keywords) removed. Right rail data collapsed into an expandable sources drawer.
 */
"use client";

import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import WantMoreModal from "./06-want-more-modal";
import SearchFeedback from "../search/06-search-feedback";
import DigDeeperModal from "./07-dig-deeper-modal";

export interface Citation {
  ref: string;
  book: string;
  url: string;
  type: "verse" | "prose";
  title: string;
}

export interface VerseHit {
  id: string; scripture: string; verse_number: string; sanskrit_devanagari: string;
  transliteration: string; translation: string; purport: string;
  chapter_number?: string; canto_or_division?: string; chapter_title?: string;
  book_slug?: string; vedabase_url?: string;
}

export interface ProseHit {
  id: string; book_slug: string; paragraph_number: number; body_text: string;
  chapter_title?: string; vedabase_url?: string;
}

export interface BookGroup {
  slug: string; name: string; verses: VerseHit[]; prose: ProseHit[];
}

export interface SearchResults {
  query: string;
  keywords: string[];
  synonyms: string[];
  relatedConcepts: string[];
  narrative: string;
  totalResults: number;
  citations: Citation[];
  books: BookGroup[];
  overflowVerses?: VerseHit[];
  overflowProse?: ProseHit[];
  totalVerses?: number;
  totalProse?: number;
}

/* ─── Book color-coding system ─── */
const BOOK_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  SB:      { bg: "#EEEDFE", text: "#534AB7", border: "#AFA9EC" },
  NOI:     { bg: "#E1F5EE", text: "#0F6E56", border: "#9FE1CB" },
  CC:      { bg: "#FAECE7", text: "#993C1D", border: "#F0997B" },
  SPL:     { bg: "#FBEAF0", text: "#993556", border: "#ED93B1" },
  BG:      { bg: "#FAEEDA", text: "#854F0B", border: "#FAC775" },
  default: { bg: "#F1EFE8", text: "#5F5E5A", border: "#B4B2A9" },
};

function getBookColor(reference: string) {
  const prefix = reference.split(" ")[0]?.toUpperCase() || "default";
  return BOOK_COLORS[prefix] || BOOK_COLORS["default"];
}

interface Props {
  results: SearchResults | null;
  isLoading: boolean;
  isStreaming?: boolean;
  streamingNarrative?: string;
  onSearch: (q: string) => void;
  searchLogId?: string | null;
}

export default function NarrativeResponse({ results, isLoading, isStreaming, streamingNarrative, onSearch, searchLogId }: Props) {
  const [modalBook, setModalBook] = useState<BookGroup | null>(null);
  const [digDeeperOpen, setDigDeeperOpen] = useState(false);
  const [isSourceDrawerOpen, setIsSourceDrawerOpen] = useState(false);

  // Reset states when results change
  useEffect(() => {
    setDigDeeperOpen(false);
    setIsSourceDrawerOpen(false);
  }, [results?.query]);

  if (isLoading) return null;
  if (!results) return null;

  if (results.totalResults === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px", gap: 12 }}>
        <p className="font-display" style={{ fontSize: "1.1rem", color: "#6B7280", fontStyle: "italic" }}>No results found.</p>
        <p className="font-body" style={{ fontSize: 14, color: "#6B7280" }}>Try different words or a simpler question.</p>
      </div>
    );
  }

  // Handle "want more" clicks from the narrative HTML
  const handleNarrativeClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const trigger = target.closest(".want-more-trigger");
    if (trigger) {
      const bookSlug = trigger.getAttribute("data-book");
      const book = results.books.find(b => b.slug === bookSlug);
      if (book) setModalBook(book);
    }
  };

  // Follow-up suggestions
  const followUps = results.relatedConcepts.slice(0, 4).map(c =>
    `What does Prabhupāda say about ${c}?`
  );

  // Book breakdown for the sources drawer
  const bookBreakdown = results.books
    .map(b => ({ name: b.name, slug: b.slug, count: b.verses.length + b.prose.length }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.count - a.count);

  // Group citations by book for the drawer
  const citationsByBook: Record<string, Citation[]> = {};
  for (const c of results.citations) {
    if (!citationsByBook[c.book]) citationsByBook[c.book] = [];
    citationsByBook[c.book].push(c);
  }

  return (
    <>
      {/* Single-column centered layout */}
      <div className="results-container" style={{ maxWidth: 780, margin: "0 auto", padding: "20px clamp(16px, 3vw, 40px)" }}>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>

          {/* ─── Sources Header Bar ─── */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 20px", marginBottom: 0,
            background: "rgba(255,255,255,0.6)", backdropFilter: "blur(10px)",
            border: "1px solid rgba(196,181,253,0.25)", borderRadius: "16px 16px 0 0",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#7C3AED" }} />
              <span className="font-body" style={{ fontSize: 14, fontWeight: 500, color: "#1a1a1a" }}>
                From Śrīla Prabhupāda&apos;s books
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="font-body" style={{ fontSize: 13, color: "#666" }}>
                {results.totalResults} sources found
              </span>
              <button
                onClick={() => setIsSourceDrawerOpen(prev => !prev)}
                className="font-body"
                style={{
                  fontSize: 12, padding: "4px 12px", background: "#E6F1FB", color: "#185FA5",
                  border: "none", borderRadius: 8, cursor: "pointer", transition: "background 0.15s ease",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "#B5D4F4"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "#E6F1FB"; }}
              >
                {isSourceDrawerOpen ? "Hide sources" : "View sources"}
              </button>
            </div>
          </div>

          {/* ─── Expandable Sources Drawer ─── */}
          <div style={{
            maxHeight: isSourceDrawerOpen ? 400 : 0, overflow: "hidden",
            transition: "max-height 0.3s ease",
            background: "rgba(255,255,255,0.5)", backdropFilter: "blur(10px)",
            borderLeft: "1px solid rgba(196,181,253,0.25)", borderRight: "1px solid rgba(196,181,253,0.25)",
          }}>
            <div style={{ padding: "16px 20px" }}>
              <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6B7280", marginBottom: 12 }}>
                Book breakdown
              </p>
              {bookBreakdown.map(book => {
                const bookObj = results.books.find(b => b.slug === book.slug);
                return (
                  <div key={book.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
                    <span className="font-body" style={{ fontSize: 13, color: "#1a1a1a" }}>{book.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="font-body" style={{ fontSize: 13, color: "#666" }}>{book.count}</span>
                      {bookObj && (
                        <button
                          onClick={() => setModalBook(bookObj)}
                          className="font-body"
                          style={{ fontSize: 11, color: "#7C3AED", background: "none", border: "none", cursor: "pointer", fontWeight: 600, textDecoration: "none" }}
                          onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; }}
                          onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; }}
                        >
                          View all →
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Citation links preview */}
              {results.citations.length > 0 && (
                <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {results.citations.slice(0, 8).map((c, i) => (
                    <a
                      key={i}
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-body"
                      style={{ fontSize: 11, color: "#8B5CF6", textDecoration: "none", padding: "3px 8px", borderRadius: 6, background: "rgba(139,92,246,0.06)", transition: "all 0.2s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.12)"; e.currentTarget.style.textDecoration = "underline"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "rgba(139,92,246,0.06)"; e.currentTarget.style.textDecoration = "none"; }}
                    >
                      {c.type === "verse" ? `📖 ${c.ref}` : `📄 ${c.title || c.ref}`}
                    </a>
                  ))}
                  {results.citations.length > 8 && (
                    <span className="font-body" style={{ fontSize: 11, color: "#6B7280", padding: "3px 0" }}>+{results.citations.length - 8} more</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ─── Narrative Card ─── */}
          <div className="aurora-card" style={{ padding: "32px clamp(20px, 3vw, 32px)", borderRadius: isSourceDrawerOpen ? "0 0 24px 24px" : "0 0 24px 24px", borderTop: "none" }}>
            <div
              className="narrative-content font-body"
              dangerouslySetInnerHTML={{ __html: (isStreaming && streamingNarrative) ? streamingNarrative : results.narrative }}
              onClick={handleNarrativeClick}
              style={{ fontSize: 15, lineHeight: 1.8, color: "#374151" }}
            />
            {isStreaming && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, opacity: 0.6 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#8B5CF6", animation: "pulse 1.2s ease-in-out infinite" }} />
                <span className="font-body" style={{ fontSize: 12, color: "#6B7280", fontStyle: "italic" }}>
                  Composing from Prabhupāda&apos;s words...
                </span>
              </div>
            )}
          </div>

          {/* Feedback widget — only show after streaming completes */}
          {!isStreaming && results && results.totalResults > 0 && (
            <SearchFeedback searchLogId={searchLogId || null} />
          )}

          {/* Dig Deeper — only show when there are results beyond the top 25 */}
          {!isStreaming && results && ((results.totalVerses || 0) + (results.totalProse || 0)) > 25 && (
            <button
              onClick={() => setDigDeeperOpen(true)}
              className="font-body"
              style={{
                width: "100%", marginTop: 16, padding: "14px 20px", borderRadius: 16,
                border: "1px dashed rgba(196,181,253,0.4)", background: "rgba(139,92,246,0.04)",
                fontSize: 14, fontWeight: 600, color: "#7C3AED", cursor: "pointer",
                textAlign: "center", transition: "all 0.3s ease",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.1)"; e.currentTarget.style.borderColor = "#8B5CF6"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "rgba(139,92,246,0.04)"; e.currentTarget.style.borderColor = "rgba(196,181,253,0.4)"; }}
            >
              Explore all {(results.totalVerses || 0) + (results.totalProse || 0)} sources →
            </button>
          )}

          {/* Follow-up questions — hidden while streaming */}
          {!isStreaming && followUps.length > 0 && (
            <div style={{ marginTop: 20, padding: "clamp(14px, 3vw, 20px) clamp(16px, 3vw, 24px)", borderRadius: 20, background: "rgba(245,240,255,0.4)", border: "1px solid rgba(196,181,253,0.2)" }}>
              <p className="font-body" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6B7280", marginBottom: 12 }}>
                People also explore
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {followUps.map(q => (
                  <button
                    key={q}
                    onClick={() => onSearch(q)}
                    className="font-body"
                    style={{ textAlign: "left", padding: "10px 16px", borderRadius: 12, border: "1px solid rgba(196,181,253,0.25)", background: "rgba(255,255,255,0.6)", fontSize: 14, color: "#374151", cursor: "pointer", transition: "all 0.3s ease" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "#8B5CF6"; e.currentTarget.style.color = "#7C3AED"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(196,181,253,0.25)"; e.currentTarget.style.color = "#374151"; }}
                  >
                    {q} →
                  </button>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* Want More Modal */}
      {modalBook && <WantMoreModal book={modalBook} onClose={() => setModalBook(null)} />}

      {/* Dig Deeper Modal */}
      {digDeeperOpen && results && (
        <DigDeeperModal
          overflowVerses={results.overflowVerses || []}
          overflowProse={results.overflowProse || []}
          totalVerses={results.totalVerses || 0}
          totalProse={results.totalProse || 0}
          onClose={() => setDigDeeperOpen(false)}
        />
      )}

      {/* Narrative + Responsive styles */}
      <style jsx global>{`
        /* Single-column responsive */
        @media (max-width: 768px) {
          .results-container {
            max-width: 100% !important;
            padding: 12px 16px !important;
          }
        }

        .narrative-content h3 {
          font-family: 'Cormorant Garamond', serif;
          font-size: 1.2rem; font-weight: 600; color: #1E1B4B;
          margin: 28px 0 12px; padding-bottom: 8px;
          border-bottom: 1px solid rgba(196,181,253,0.2);
        }
        .narrative-content h3:first-child { margin-top: 0; }
        .narrative-content p { margin-bottom: 12px; font-size: 15px; line-height: 1.8; color: #374151; }
        .narrative-content .verse-quote {
          background: rgba(245,240,255,0.5); border: 1px solid rgba(196,181,253,0.25);
          border-left: 3px solid #8B5CF6; padding: 14px 18px; border-radius: 12px; margin: 12px 0;
          font-family: 'Cormorant Garamond', serif; font-size: 1.02rem; font-style: italic; line-height: 1.7; color: #1E1B4B;
        }
        .narrative-content .purport-quote {
          background: rgba(139,92,246,0.04); border: 1px solid rgba(196,181,253,0.18);
          border-left: 3px solid #7C3AED; padding: 14px 18px; border-radius: 12px; margin: 12px 0;
          font-size: 14px; line-height: 1.8; color: #374151;
        }
        .narrative-content .prose-quote {
          background: rgba(245,240,255,0.3); border: 1px solid rgba(196,181,253,0.15);
          border-left: 3px solid #6366F1; padding: 14px 18px; border-radius: 12px; margin: 12px 0;
          font-size: 14px; line-height: 1.8; color: #374151;
        }
        .narrative-content .verse-ref {
          font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600;
          color: #8B5CF6; font-style: normal;
        }
        .narrative-content .verse-link {
          text-decoration: none; color: #8B5CF6;
        }
        .narrative-content .verse-link:hover { text-decoration: underline; }
        .narrative-content .want-more-trigger {
          text-align: center; padding: 12px; margin: 16px 0 8px;
          font-size: 13px; font-weight: 600; color: #7C3AED; cursor: pointer;
          border: 1px dashed rgba(196,181,253,0.4); border-radius: 12px;
          background: rgba(139,92,246,0.04); transition: all 0.3s ease;
        }
        .narrative-content .want-more-trigger:hover {
          background: rgba(139,92,246,0.1); border-color: #8B5CF6;
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.3); }
        }
      `}</style>
    </>
  );
}
