/**
 * 01-narrative-response.tsx — Narrative Response with Summary Sidebar
 *
 * 2-column layout: 75% content + 25% sidebar (220px).
 * Sidebar shows numbered key answers (AI-generated) and sources-by-book counts.
 * Mobile: sidebar hidden, replaced by "View key answers" button + bottom-sheet popup.
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
  book_slug?: string; vedabase_url?: string; tags?: string[];
  score?: number; similarity?: number;
}

export interface ProseHit {
  id: string; book_slug: string; paragraph_number: number; body_text: string;
  chapter_title?: string; vedabase_url?: string; tags?: string[];
  score?: number; similarity?: number;
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
  articleVerseIds?: string[];
}

/* ─── Per-book color system (ONLY for tags and left borders) ─── */
const BOOK_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  SB:      { bg: "#EEEDFE", text: "#534AB7", border: "#AFA9EC" },
  CC:      { bg: "#FAECE7", text: "#993C1D", border: "#F0997B" },
  NOI:     { bg: "#E1F5EE", text: "#0F6E56", border: "#9FE1CB" },
  BG:      { bg: "#FAEEDA", text: "#854F0B", border: "#FAC775" },
  SPL:     { bg: "#FBEAF0", text: "#993556", border: "#ED93B1" },
  default: { bg: "#EEEDFE", text: "#534AB7", border: "#AFA9EC" },
};

export function getBookColor(reference: string) {
  const prefix = reference.split(" ")[0]?.toUpperCase() || "default";
  return BOOK_COLORS[prefix] || BOOK_COLORS["default"];
}

/* ─── Scroll helper ─── */
function scrollToSource(ref: string) {
  document.getElementById(`source-${ref}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ─── Summary item type ─── */
interface SummaryItem {
  summary: string;
  reference: string;
}

/* ─── Mobile Summary Bottom-Sheet Popup ─── */
function SummaryPopup({
  isOpen,
  onClose,
  summaries,
  totalSources,
}: {
  isOpen: boolean;
  onClose: () => void;
  summaries: SummaryItem[];
  totalSources: number;
}) {
  if (!isOpen) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100,
          animation: "summaryFadeIn 0.2s ease",
        }}
      />
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0, background: "white",
        borderRadius: "16px 16px 0 0", zIndex: 101, maxHeight: "80vh", overflowY: "auto",
        animation: "summarySlideUp 0.3s ease",
      }}>
        <div style={{ width: 36, height: 4, background: "#D0D0D0", borderRadius: 2, margin: "10px auto 0" }} />
        <div style={{ padding: "16px 20px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M8 1.5l2 4 4.5.7-3.2 3.1.8 4.4L8 11.5l-4.1 2.2.8-4.4L1.5 6.2l4.5-.7z" fill="#7F77DD" stroke="none" />
            </svg>
            <span className="font-body" style={{ fontSize: 16, fontWeight: 500 }}>Key answers</span>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.1)",
              background: "transparent", fontSize: 14, color: "#888", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            &times;
          </button>
        </div>
        <p className="font-body" style={{ fontSize: 12, color: "#888", margin: "0 20px 16px" }}>
          Top {summaries.length} most relevant from {totalSources} sources
        </p>
        <div style={{ padding: "0 20px 24px" }}>
          {summaries.map((item, i) => (
            <div
              key={i}
              onClick={() => { onClose(); setTimeout(() => scrollToSource(item.reference), 300); }}
              style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 0",
                borderBottom: i < summaries.length - 1 ? "1px solid rgba(0,0,0,0.06)" : "none",
                cursor: "pointer",
              }}
            >
              <span style={{
                fontSize: 12, fontWeight: 500, color: "white", background: "#7F77DD",
                width: 22, height: 22, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>{i + 1}</span>
              <div>
                <p className="font-body" style={{ fontSize: 14, fontWeight: 500, margin: "0 0 4px", lineHeight: 1.5 }}>{item.summary}</p>
                <span className="font-body" style={{ fontSize: 11, color: "#534AB7", background: "#EEEDFE", padding: "1px 8px", borderRadius: 4 }}>
                  {item.reference}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ─── Expandable Reference Card ─── */
function ExpandableReferenceCard({ children, preview, fullText }: {
  children: React.ReactNode;
  preview: string;
  fullText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer" }}>
      {children}
      <p className="reference-card__purport" style={{ marginTop: 8 }}>
        {expanded ? fullText : preview}
        {fullText.length > 200 && (
          <span style={{ color: "#534AB7", fontWeight: 500, marginLeft: 4, fontSize: 12 }}>
            {expanded ? " Show less" : " ...Read more"}
          </span>
        )}
      </p>
    </div>
  );
}

/* ─── Main Component ─── */
interface Props {
  results: SearchResults | null;
  isLoading: boolean;
  isStreaming?: boolean;
  streamingNarrative?: string;
  onSearch: (q: string) => void;
  searchLogId?: string | null;
  viewMode: "article" | "references";
  onViewModeChange: (mode: "article" | "references") => void;
}

export default function NarrativeResponse({ results, isLoading, isStreaming, streamingNarrative, onSearch, searchLogId, viewMode, onViewModeChange }: Props) {
  const [modalBook, setModalBook] = useState<BookGroup | null>(null);
  const [digDeeperOpen, setDigDeeperOpen] = useState(false);
  const [summaries, setSummaries] = useState<SummaryItem[]>([]);
  const [showSummaryPopup, setShowSummaryPopup] = useState(false);

  // Reset states when results change
  useEffect(() => {
    setDigDeeperOpen(false);
    setSummaries([]);
    setShowSummaryPopup(false);
  }, [results?.query]);

  // Fetch AI-generated summaries when search results arrive
  useEffect(() => {
    if (!results || results.totalResults === 0) return;

    // Build passage list from citations and books
    const passages: { reference: string; text: string }[] = [];
    for (const book of results.books) {
      for (const v of book.verses) {
        const ref = `${v.scripture || ""} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number ? v.chapter_number + "." : ""}${v.verse_number}`;
        passages.push({ reference: ref.trim(), text: v.translation || v.purport || "" });
      }
      for (const p of book.prose) {
        passages.push({ reference: p.chapter_title || `${p.book_slug} #${p.paragraph_number}`, text: p.body_text || "" });
      }
    }

    const top10 = passages.slice(0, 10);
    if (top10.length === 0) return;

    fetch("/api/generate-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passages: top10 }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.summaries && Array.isArray(data.summaries)) {
          setSummaries(
            data.summaries.map((s: string, i: number) => ({
              summary: s,
              reference: top10[i]?.reference || "",
            }))
          );
        }
      })
      .catch(() => {
        // Silently fail — sidebar just won't show summaries
      });
  }, [results]);

  // Follow-up suggestions — extract themes from search results
  const followUps = useMemo(() => {
    if (!results || results.totalResults === 0) return [];
    const themes = results.citations
      .slice(0, 10)
      .map(c => c.title)
      .filter(t => t && t.length > 5)
      .slice(0, 3);
    if (themes.length === 0) return [];
    return themes.map(t => `What does Prabhupāda teach about ${t}?`);
  }, [results]);

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

  // Book breakdown for sidebar
  const bookGroups = results.books
    .map(b => ({ name: b.name, slug: b.slug, count: b.verses.length + b.prose.length }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <>
      {/* Controls row — sits ABOVE the grid */}
      <div className="results-controls-row">
        {/* Mobile: View key answers button */}
        {summaries.length > 0 && (
          <div
            className="mobile-only-btn"
            onClick={() => setShowSummaryPopup(true)}
            style={{
              width: "100%", padding: "12px 16px", background: "#EEEDFE", border: "1px solid #CECBF6",
              borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center",
              justifyContent: "space-between", marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 16 16">
                <path d="M8 1.5l2 4 4.5.7-3.2 3.1.8 4.4L8 11.5l-4.1 2.2.8-4.4L1.5 6.2l4.5-.7z" fill="#7F77DD" stroke="none" />
              </svg>
              <span className="font-body" style={{ fontSize: 13, fontWeight: 500, color: "#3C3489" }}>View key answers</span>
            </div>
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path d="M5 3l5 4-5 4" fill="none" stroke="#3C3489" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        )}

        {/* ─── Article / References Toggle ─── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span className="font-body" style={{ fontSize: 12, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em" }}>View as</span>
          <div className="view-mode-toggle">
            <button
              className={`font-body${viewMode === "article" ? " active" : ""}`}
              onClick={() => onViewModeChange("article")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="1" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <line x1="4.5" y1="4" x2="9.5" y2="4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <line x1="4.5" y1="6.5" x2="9.5" y2="6.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <line x1="4.5" y1="9" x2="7.5" y2="9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              </svg>
              Article
            </button>
            <button
              className={`font-body${viewMode === "references" ? " active" : ""}`}
              onClick={() => onViewModeChange("references")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1.5" width="4" height="5" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <rect x="1" y="7.5" width="4" height="5" rx="0.5" stroke="currentColor" strokeWidth="1" />
                <line x1="7" y1="2.5" x2="13" y2="2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <line x1="7" y1="4.5" x2="11" y2="4.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                <line x1="7" y1="8.5" x2="13" y2="8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                <line x1="7" y1="10.5" x2="11" y2="10.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
              </svg>
              References
            </button>
          </div>
        </div>
      </div>

      {/* 2-column grid — both columns now start at the same level */}
      <div className="results-grid-container">
        {/* ─── Content Column ─── */}
        <div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>

            {/* ─── Article Mode ─── */}
            {viewMode === "article" && (
              <div style={{ opacity: 1, transform: "translateY(0)", transition: "opacity 0.2s ease, transform 0.2s ease" }}>
                <div className="aurora-card" style={{ padding: "32px clamp(20px, 3vw, 32px)", borderRadius: 24 }}>
                  <div
                    className="narrative-content font-body"
                    dangerouslySetInnerHTML={{ __html: (isStreaming && streamingNarrative) ? streamingNarrative : results.narrative }}
                    onClick={handleNarrativeClick}
                    style={{ fontSize: 15, lineHeight: 1.8, color: "#374151" }}
                  />
                  {isStreaming && (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 10, marginTop: 16, padding: "12px 16px",
                      borderRadius: 12, background: "rgba(139,92,246,0.04)", border: "1px solid rgba(196,181,253,0.2)",
                    }}>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[0, 1, 2].map(i => (
                          <div key={i} style={{
                            width: 6, height: 6, borderRadius: "50%", background: "#8B5CF6",
                            animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
                          }} />
                        ))}
                      </div>
                      <span className="font-body" style={{ fontSize: 13, color: "#7C3AED", fontWeight: 500 }}>
                        Weaving Prabhupāda&apos;s words into a narrative...
                      </span>
                      <span style={{
                        width: 2, height: 16, background: "#8B5CF6", borderRadius: 1, marginLeft: "auto",
                        animation: "streamCursorBlink 0.8s step-end infinite",
                      }} />
                    </div>
                  )}
                </div>

                {/* Feedback widget */}
                {!isStreaming && results && results.totalResults > 0 && (
                  <SearchFeedback searchLogId={searchLogId || null} />
                )}

                {/* Dig Deeper */}
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
                    Explore all {(results.overflowVerses?.length || 0) + (results.overflowProse?.length || 0)} additional sources
                    ({results.overflowVerses?.length || 0} verses · {results.overflowProse?.length || 0} passages) &rarr;
                  </button>
                )}

                {/* Follow-up questions */}
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
                          {q} &rarr;
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ─── References Mode ─── */}
            {viewMode === "references" && (
              <div style={{ opacity: 1, transform: "translateY(0)", transition: "opacity 0.2s ease, transform 0.2s ease" }}>
                {results.books.filter(b => b.verses.length > 0 || b.prose.length > 0).map(book => {
                  const bookColor = getBookColor(book.slug.toUpperCase());
                  return (
                    <div key={book.slug} className="references-book-group">
                      <h3>{book.name}</h3>
                      <p className="references-book-count">
                        {book.verses.length > 0 && `${book.verses.length} verse${book.verses.length !== 1 ? "s" : ""}`}
                        {book.verses.length > 0 && book.prose.length > 0 && " · "}
                        {book.prose.length > 0 && `${book.prose.length} passage${book.prose.length !== 1 ? "s" : ""}`}
                      </p>

                      {book.verses.map(v => {
                        const ref = `${v.scripture || ""} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number ? v.chapter_number + "." : ""}${v.verse_number}`.trim();
                        const vColor = getBookColor(ref);
                        return (
                          <div key={v.id} className="reference-card" id={`source-${ref}`} style={{ borderLeft: `3px solid ${vColor.border}` }}>
                            <span style={{
                              display: "inline-block", fontSize: 11, fontWeight: 500, padding: "2px 8px",
                              borderRadius: 8, background: vColor.bg, color: vColor.text,
                            }}>
                              [{ref}]
                            </span>
                            {v.translation && (
                              <p className="reference-card__translation">{v.translation}</p>
                            )}
                            {v.purport && (
                              <ExpandableReferenceCard
                                preview={v.purport.length > 200 ? v.purport.slice(0, 200) + "…" : v.purport}
                                fullText={v.purport}
                              >
                                <span />
                              </ExpandableReferenceCard>
                            )}
                            <div className="reference-card__links">
                              <a href={`/verse/${v.id}`} style={{ color: "#534AB7" }}>
                                Read full purport &rarr;
                              </a>
                              {v.vedabase_url && (
                                <a href={v.vedabase_url} target="_blank" rel="noopener noreferrer" style={{ color: "#888" }}>
                                  Open on Vedabase &#8599;
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {book.prose.map(p => (
                        <div key={p.id} className="reference-card" id={`source-${p.chapter_title || `${p.book_slug} #${p.paragraph_number}`}`} style={{ borderLeft: `3px solid ${bookColor.border}` }}>
                          {p.chapter_title && (
                            <span style={{
                              display: "inline-block", fontSize: 11, fontWeight: 500, padding: "2px 8px",
                              borderRadius: 8, background: bookColor.bg, color: bookColor.text,
                            }}>
                              {p.chapter_title}
                            </span>
                          )}
                          <ExpandableReferenceCard
                            preview={p.body_text.length > 250 ? p.body_text.slice(0, 250) + "…" : p.body_text}
                            fullText={p.body_text}
                          >
                            <span />
                          </ExpandableReferenceCard>
                          <div className="reference-card__links">
                            <span />
                            {p.vedabase_url && (
                              <a href={p.vedabase_url} target="_blank" rel="noopener noreferrer" style={{ color: "#888" }}>
                                Open on Vedabase &#8599;
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}

                {/* Dig Deeper in references mode */}
                {results && ((results.totalVerses || 0) + (results.totalProse || 0)) > 25 && (
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
                    Explore all {(results.overflowVerses?.length || 0) + (results.overflowProse?.length || 0)} additional sources
                    ({results.overflowVerses?.length || 0} verses · {results.overflowProse?.length || 0} passages) &rarr;
                  </button>
                )}
              </div>
            )}
          </motion.div>
        </div>

        {/* ─── Desktop Summary Sidebar ─── */}
        <div className="desktop-sidebar" style={{ opacity: 1 }}>
          <div style={{
            background: "white", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 12,
            padding: 16, position: "sticky", top: 80, alignSelf: "start",
          }}>
            {/* Key answers section */}
            {summaries.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <path d="M7 1l1.8 3.6L13 5.3l-3 2.9.7 4.1L7 10.4l-3.7 1.9.7-4.1-3-2.9 4.2-.7z" fill="#7F77DD" stroke="none" />
                  </svg>
                  <span className="font-body" style={{ fontSize: 13, fontWeight: 500 }}>Key answers</span>
                </div>
                {summaries.map((item, i) => (
                  <div
                    key={i}
                    onClick={() => scrollToSource(item.reference)}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 12,
                      animation: `sidebarItemIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.08}s both`,
                    }}
                  >
                    <span style={{
                      fontSize: 11, fontWeight: 500, color: "#534AB7", background: "#EEEDFE",
                      padding: "1px 6px", borderRadius: 4, whiteSpace: "nowrap", marginTop: 2,
                      animation: `badgePop 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${i * 0.08 + 0.1}s both`,
                    }}>{i + 1}</span>
                    <div>
                      <p className="font-body" style={{ fontSize: 12, margin: "0 0 2px", lineHeight: 1.5 }}>{item.summary}</p>
                      <span className="font-body" style={{ fontSize: 11, color: "#888" }}>{item.reference}</span>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Loading state for summaries */}
            {summaries.length === 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                <svg width="14" height="14" viewBox="0 0 14 14">
                  <path d="M7 1l1.8 3.6L13 5.3l-3 2.9.7 4.1L7 10.4l-3.7 1.9.7-4.1-3-2.9 4.2-.7z" fill="#7F77DD" stroke="none" />
                </svg>
                <span className="font-body" style={{ fontSize: 13, fontWeight: 500, color: "#888" }}>Generating key answers...</span>
              </div>
            )}

            {/* Divider */}
            <div style={{ borderTop: "1px solid rgba(0,0,0,0.06)", margin: "14px 0" }} />

            {/* Sources by book */}
            <p className="font-body" style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.3px", margin: "0 0 8px" }}>
              Sources by book
            </p>
            {bookGroups.map(g => (
              <div key={g.name} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                <span className="font-body" style={{ fontSize: 12 }}>{g.name}</span>
                <span className="font-body" style={{ fontSize: 11, color: "#888" }}>{g.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile Summary Popup */}
      <SummaryPopup
        isOpen={showSummaryPopup}
        onClose={() => setShowSummaryPopup(false)}
        summaries={summaries}
        totalSources={results.totalResults}
      />

      {/* Want More Modal */}
      {modalBook && <WantMoreModal book={modalBook} onClose={() => setModalBook(null)} />}

      {/* Dig Deeper Modal */}
      {digDeeperOpen && results && (
        <DigDeeperModal
          overflowVerses={results.overflowVerses || []}
          overflowProse={results.overflowProse || []}
          totalVerses={results.totalVerses || 0}
          totalProse={results.totalProse || 0}
          articleVerseIds={new Set(results.articleVerseIds || [])}
          onClose={() => setDigDeeperOpen(false)}
        />
      )}

      {/* Styles */}
      <style jsx global>{`
        /* Controls row above grid */
        .results-controls-row {
          max-width: 1100px;
          margin: 0 auto;
          padding: 0 20px;
        }

        @media (max-width: 768px) {
          .results-controls-row {
            padding: 0 16px;
          }
        }

        /* 2-column grid: content (1fr) + sidebar (220px) — aligned at top */
        .results-grid-container {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 220px;
          gap: 20px;
          align-items: start;
          max-width: 1100px;
          margin: 0 auto;
          padding: 0 20px;
        }

        /* Mobile: single column */
        @media (max-width: 768px) {
          .results-grid-container {
            grid-template-columns: 1fr;
            padding: 0 16px;
          }
        }

        /* Desktop sidebar visibility */
        .desktop-sidebar { display: block; }
        @media (max-width: 768px) { .desktop-sidebar { display: none; } }

        /* Mobile button visibility */
        .mobile-only-btn { display: none !important; }
        @media (max-width: 768px) { .mobile-only-btn { display: flex !important; } }

        /* Bottom-sheet animations */
        @keyframes summaryFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes summarySlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

        /* Scripture card styles */
        .scripture-card {
          padding: 16px 20px;
          margin-bottom: 20px;
          border-left: 3px solid #AFA9EC;
          background: #FAFAFA;
          border-radius: 0 8px 8px 0;
        }
        .scripture-card__reference-tag {
          display: inline-block;
          font-size: 11px;
          font-weight: 500;
          padding: 2px 8px;
          border-radius: 8px;
          margin-bottom: 10px;
          background: #EEEDFE;
          color: #534AB7;
        }
        .scripture-card__text {
          font-size: 16px;
          line-height: 1.8;
          font-style: italic;
          font-family: Georgia, 'Times New Roman', serif;
          color: #1a1a1a;
          margin: 0;
        }
        @media (max-width: 768px) {
          .scripture-card__text {
            font-size: 15px;
            line-height: 1.75;
          }
        }

        /* Verse and purport blocks animate in when they appear during streaming */
        .narrative-content .verse-quote,
        .narrative-content .purport-quote,
        .narrative-content .prose-quote {
          animation: verseBorderGrow 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
        }

        /* Stagger h3 headings in the narrative */
        .narrative-content h3 {
          animation: fadeInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
        }

        /* Narrative content styles */
        .narrative-content h3 {
          font-family: 'Cormorant Garamond', serif;
          font-size: 1.2rem; font-weight: 600; color: #1E1B4B;
          margin: 28px 0 12px; padding-bottom: 8px;
          border-bottom: 1px solid rgba(196,181,253,0.2);
        }
        .narrative-content h3:first-child { margin-top: 0; }
        .narrative-content p {
          margin-bottom: 16px; font-size: 16px; line-height: 1.85; color: #1E1B4B;
        }
        .narrative-content .verse-quote {
          background: transparent; border: none;
          border-left: 3px solid #8B5CF6; padding: 12px 20px; border-radius: 0; margin: 20px 0;
          font-family: Georgia, 'Times New Roman', serif; font-size: 16px; font-style: italic; line-height: 1.8; color: #1E1B4B;
        }
        .narrative-content .purport-quote {
          background: transparent; border: none;
          border-left: 3px solid #7C3AED; padding: 12px 20px; border-radius: 0; margin: 16px 0;
          font-size: 15px; line-height: 1.8; color: #374151;
        }
        .narrative-content .prose-quote {
          background: transparent; border: none;
          border-left: 3px solid #6366F1; padding: 12px 20px; border-radius: 0; margin: 16px 0;
          font-size: 15px; line-height: 1.8; color: #374151;
        }
        .narrative-content .verse-ref {
          font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600;
          color: #8B5CF6; font-style: normal;
        }
        .narrative-content .verse-link { text-decoration: none; color: #8B5CF6; }
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
        @keyframes articlePulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        /* Article/References toggle */
        .view-mode-toggle {
          display: inline-flex;
          border: 1px solid rgba(0,0,0,0.12);
          border-radius: 10px;
          overflow: hidden;
        }
        .view-mode-toggle button {
          padding: 8px 18px;
          font-size: 13px;
          font-weight: 500;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .view-mode-toggle button.active {
          background: #534AB7;
          color: white;
        }
        .view-mode-toggle button:not(.active) {
          background: transparent;
          color: #666;
        }
        .view-mode-toggle button:not(.active):hover {
          background: rgba(83, 74, 183, 0.08);
        }

        /* References view cards */
        .references-book-group {
          margin-bottom: 32px;
        }
        .references-book-group h3 {
          font-family: 'Cormorant Garamond', serif;
          font-size: 1.15rem;
          font-weight: 600;
          color: #1E1B4B;
          margin: 0 0 4px;
        }
        .references-book-count {
          font-size: 12px;
          color: #888;
          margin-bottom: 16px;
        }
        .reference-card {
          margin-bottom: 14px;
          padding: 16px 20px;
          background: #FAFAFA;
          border-radius: 0 8px 8px 0;
          transition: background 0.2s ease;
        }
        .reference-card:hover {
          background: #F5F3FF;
        }
        .reference-card__translation {
          font-size: 15px;
          line-height: 1.8;
          font-style: italic;
          font-family: Georgia, 'Times New Roman', serif;
          color: #1a1a1a;
          margin: 8px 0;
        }
        .reference-card__purport {
          font-size: 13px;
          line-height: 1.7;
          color: #555;
          margin: 8px 0;
        }
        .reference-card__links {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-top: 8px;
        }
        .reference-card__links a {
          font-size: 12px;
          font-weight: 500;
          text-decoration: none;
          transition: text-decoration 0.2s;
        }
        .reference-card__links a:hover {
          text-decoration: underline;
        }

        @media (max-width: 768px) {
          .view-mode-toggle button {
            padding: 10px 16px;
            font-size: 14px;
          }
        }
      `}</style>
    </>
  );
}