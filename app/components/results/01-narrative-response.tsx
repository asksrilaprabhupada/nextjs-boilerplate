/**
 * 01-narrative-response.tsx — Narrative Response Layout
 *
 * Renders the 3-column search results with left rail (keywords), center narrative (AI answer with citations), and right rail (book citations).
 * This is the core display component that presents Srila Prabhupada's teachings as a flowing narrative answer.
 */
"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import LeftRail from "./02-left-rail";
import RightRail from "./03-right-rail";
import WantMoreModal from "./06-want-more-modal";
import SearchFeedback from "../search/06-search-feedback";

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

  if (isLoading) {
    // SearchProgress component in HeroSearch handles the loading state now
    return null;
  }

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

  return (
    <>
      <div className="search-results-layout" style={{ maxWidth: 1280, margin: "0 auto", padding: "20px clamp(12px, 3vw, 40px)", display: "grid", gridTemplateColumns: "260px 1fr 280px", gap: "clamp(14px, 2vw, 24px)", alignItems: "start" }}>

        {/* LEFT RAIL */}
        <LeftRail
          keywords={results.keywords}
          synonyms={results.synonyms}
          relatedConcepts={results.relatedConcepts}
          onSearch={onSearch}
        />

        {/* CENTER — Main Answer */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          {/* Keywords used */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16, justifyContent: "center" }}>
            <span className="font-body" style={{ fontSize: 12, color: "#6B7280" }}>Searched:</span>
            {results.keywords.slice(0, 6).map(k => (
              <span key={k} className="font-body" style={{ fontSize: 11, padding: "2px 10px", borderRadius: 100, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(196,181,253,0.3)", color: "#7C3AED", fontWeight: 500 }}>{k}</span>
            ))}
          </div>

          {/* Narrative card */}
          <div className="aurora-card" style={{ padding: "32px clamp(20px, 3vw, 32px)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg, #8B5CF6, #7C3AED)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </div>
              <span className="font-body" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "#7C3AED" }}>
                From Śrīla Prabhupāda&apos;s Books
              </span>
              <span className="font-body" style={{ fontSize: 11, color: "#6B7280", marginLeft: "auto" }}>
                {results.totalResults} sources found
              </span>
            </div>

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

        {/* RIGHT RAIL */}
        <RightRail citations={results.citations} books={results.books} onWantMore={setModalBook} />
      </div>

      {/* Want More Modal */}
      {modalBook && <WantMoreModal book={modalBook} onClose={() => setModalBook(null)} />}

      {/* Responsive + Narrative styles */}
      <style jsx global>{`
        @media (max-width: 1024px) {
          .search-results-layout {
            grid-template-columns: 1fr !important;
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