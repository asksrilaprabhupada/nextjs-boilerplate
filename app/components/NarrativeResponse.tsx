"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import BookResultCard from "./BookResultCard";

export interface VerseResult {
  id: string;
  scripture: string;
  verse_number: string;
  sanskrit_devanagari: string;
  transliteration: string;
  translation: string;
  purport: string;
  chapter_number?: string;
  canto_or_division?: string;
  chapter_title?: string;
  book_slug?: string;
  content_type: "verse";
}

export interface ProseResult {
  id: string;
  book_slug: string;
  paragraph_number: number;
  body_text: string;
  chapter_title?: string;
  vedabase_url?: string;
  content_type: "prose";
}

export interface BookGroup {
  book_slug: string;
  book_name: string;
  verses: VerseResult[];
  prose: ProseResult[];
}

export interface SearchResults {
  query: string;
  keywords: string[];
  narrative: string;
  total_results: number;
  books: BookGroup[];
}

interface NarrativeResponseProps {
  results: SearchResults | null;
  isLoading: boolean;
}

export default function NarrativeResponse({ results, isLoading }: NarrativeResponseProps) {
  const [showRawResults, setShowRawResults] = useState(false);

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "80px 20px",
          gap: 16,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            border: "2px solid rgba(196, 181, 253, 0.3)",
            borderTopColor: "#8B5CF6",
            animation: "spin 0.8s linear infinite",
          }}
        />
        <p
          className="font-display"
          style={{
            fontSize: "1.05rem",
            fontStyle: "italic",
            color: "#9CA3AF",
          }}
        >
          Searching across 27 books of Śrīla Prabhupāda...
        </p>
        <p
          className="font-body"
          style={{ fontSize: 13, color: "#C4B5FD" }}
        >
          Finding verses, reading purports, preparing your answer...
        </p>
      </div>
    );
  }

  if (!results) return null;

  if (results.total_results === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "60px 20px",
          gap: 12,
        }}
      >
        <p
          className="font-display"
          style={{ fontSize: "1.1rem", color: "#9CA3AF", fontStyle: "italic" }}
        >
          No results found for this query.
        </p>
        <p className="font-body" style={{ fontSize: 14, color: "#9CA3AF" }}>
          Try using different words or a simpler question.
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", paddingBottom: 60 }}>
      {/* Keywords used */}
      <div
        style={{
          maxWidth: 700,
          margin: "0 auto",
          padding: "16px clamp(20px, 4vw, 40px) 0",
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          justifyContent: "center",
        }}
      >
        <span className="font-body" style={{ fontSize: 12, color: "#9CA3AF", marginRight: 4 }}>
          Searched for:
        </span>
        {results.keywords.map((kw) => (
          <span
            key={kw}
            className="font-body"
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 100,
              background: "rgba(139, 92, 246, 0.08)",
              border: "1px solid rgba(196, 181, 253, 0.3)",
              color: "#7C3AED",
              fontWeight: 500,
            }}
          >
            {kw}
          </span>
        ))}
      </div>

      {/* AI Narrative Response */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        style={{
          maxWidth: 700,
          margin: "24px auto 0",
          padding: "0 clamp(20px, 4vw, 40px)",
        }}
      >
        <div
          className="aurora-card"
          style={{ padding: "32px clamp(20px, 3vw, 32px)" }}
        >
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: "linear-gradient(135deg, #8B5CF6, #7C3AED)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span
              className="font-body"
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                color: "#7C3AED",
              }}
            >
              From Śrīla Prabhupāda&apos;s Books
            </span>
          </div>

          {/* Narrative HTML content */}
          <div
            className="narrative-content font-body"
            dangerouslySetInnerHTML={{ __html: results.narrative }}
            style={{
              fontSize: 15,
              lineHeight: 1.8,
              color: "#4B5563",
            }}
          />
        </div>
      </motion.div>

      {/* Show Raw Scripture References button */}
      <div
        style={{
          maxWidth: 700,
          margin: "24px auto 0",
          padding: "0 clamp(20px, 4vw, 40px)",
          textAlign: "center",
        }}
      >
        <button
          onClick={() => setShowRawResults(!showRawResults)}
          className="btn-ghost"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {showRawResults ? "Hide" : "View"} Original Scripture References ({results.total_results})
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            style={{
              transform: showRawResults ? "rotate(180deg)" : "none",
              transition: "transform 0.3s ease",
            }}
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Raw results by book */}
      {showRawResults && results.books.map((book, index) => (
        <BookResultCard key={book.book_slug} book={book} index={index} />
      ))}

      {/* Narrative content styles */}
      <style jsx global>{`
        .narrative-content h3 {
          font-family: 'Cormorant Garamond', serif;
          font-size: 1.25rem;
          font-weight: 600;
          color: #1E1B4B;
          margin: 28px 0 14px 0;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(196, 181, 253, 0.2);
        }

        .narrative-content h3:first-child {
          margin-top: 0;
        }

        .narrative-content p {
          margin-bottom: 14px;
          font-size: 15px;
          line-height: 1.8;
          color: #4B5563;
        }

        .narrative-content .verse-quote {
          background: rgba(245, 240, 255, 0.5);
          border: 1px solid rgba(196, 181, 253, 0.25);
          border-left: 3px solid #8B5CF6;
          padding: 16px 20px;
          border-radius: 12px;
          margin: 14px 0;
          font-family: 'Cormorant Garamond', serif;
          font-size: 1.05rem;
          font-style: italic;
          line-height: 1.7;
          color: #1E1B4B;
        }

        .narrative-content .purport-quote {
          background: rgba(139, 92, 246, 0.04);
          border: 1px solid rgba(196, 181, 253, 0.18);
          border-left: 3px solid #7C3AED;
          padding: 16px 20px;
          border-radius: 12px;
          margin: 14px 0;
          font-size: 14px;
          line-height: 1.8;
          color: #4B5563;
        }

        .narrative-content .prose-quote {
          background: rgba(245, 240, 255, 0.3);
          border: 1px solid rgba(196, 181, 253, 0.15);
          border-left: 3px solid #6366F1;
          padding: 16px 20px;
          border-radius: 12px;
          margin: 14px 0;
          font-size: 14px;
          line-height: 1.8;
          color: #4B5563;
        }

        .narrative-content .verse-ref {
          font-family: 'DM Sans', sans-serif;
          font-size: 12px;
          font-weight: 600;
          color: #8B5CF6;
          font-style: normal;
          letter-spacing: 0.02em;
        }
      `}</style>
    </div>
  );
}