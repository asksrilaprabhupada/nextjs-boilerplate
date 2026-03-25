"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import type { BookGroup } from "./NarrativeResponse";

interface BookResultCardProps {
  book: BookGroup;
  index: number;
}

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text || "";
  const cut = text.substring(0, max);
  const lastPeriod = cut.lastIndexOf(".");
  return lastPeriod > max * 0.5 ? cut.substring(0, lastPeriod + 1) : cut + "...";
}

function formatVerseRef(verse: {
  scripture: string;
  verse_number: string;
  canto_or_division?: string;
  chapter_number?: string;
}): string {
  const prefix = verse.scripture || "";
  const canto = verse.canto_or_division ? `${verse.canto_or_division}.` : "";
  const ch = verse.chapter_number || "";
  return `${prefix} ${canto}${ch}.${verse.verse_number}`;
}

export default function BookResultCard({ book, index }: BookResultCardProps) {
  const [showPurports, setShowPurports] = useState<Set<string>>(new Set());

  const totalResults = book.verses.length + book.prose.length;
  if (totalResults === 0) return null;

  const togglePurport = (id: string) => {
    setShowPurports((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      style={{ width: "100%" }}
    >
      <div
        style={{
          maxWidth: 700,
          margin: "0 auto",
          padding: "24px clamp(20px, 4vw, 40px)",
        }}
      >
        <div className="aurora-card" style={{ padding: "28px clamp(20px, 3vw, 32px)" }}>
          {/* Book header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 7,
                background: "linear-gradient(135deg, #8B5CF6, #7C3AED)",
                flexShrink: 0,
              }}
            />
            <span
              className="font-body"
              style={{
                fontSize: 11,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "#6B7280",
              }}
            >
              FROM {book.name.toUpperCase()}
            </span>
          </div>

          <div
            style={{
              width: 50,
              height: 2,
              background: "#8B5CF6",
              marginBottom: 24,
              borderRadius: 1,
              opacity: 0.6,
            }}
          />

          {/* Verse results */}
          {book.verses.map((verse) => (
            <div key={verse.id} style={{ marginBottom: 20 }}>
              {/* Verse block */}
              <div
                style={{
                  background: "rgba(245, 240, 255, 0.5)",
                  border: "1px solid rgba(196, 181, 253, 0.25)",
                  borderLeft: "3px solid #8B5CF6",
                  padding: "20px 24px",
                  borderRadius: 16,
                }}
              >
                {verse.sanskrit_devanagari && (
                  <p
                    style={{
                      fontFamily: "'Noto Serif Devanagari', serif",
                      fontSize: "1.05rem",
                      lineHeight: 1.9,
                      fontWeight: 500,
                      color: "#1E1B4B",
                      marginBottom: 10,
                    }}
                  >
                    {verse.sanskrit_devanagari}
                  </p>
                )}
                <p
                  className="font-display"
                  style={{
                    fontSize: "1.05rem",
                    fontWeight: 400,
                    fontStyle: "italic",
                    lineHeight: 1.7,
                    color: "#1E1B4B",
                  }}
                >
                  &ldquo;{verse.translation}&rdquo;
                </p>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 10,
                  }}
                >
                  <Link
                    href={`/verse/${verse.id}`}
                    className="font-body"
                    style={{
                      fontSize: 13,
                      color: "#8B5CF6",
                      textDecoration: "none",
                      fontWeight: 500,
                    }}
                  >
                    — {formatVerseRef(verse)}
                  </Link>
                  {verse.purport && (
                    <button
                      onClick={() => togglePurport(verse.id)}
                      className="font-body"
                      style={{
                        fontSize: 12,
                        color: "#7C3AED",
                        background: "rgba(139, 92, 246, 0.08)",
                        border: "1px solid rgba(196, 181, 253, 0.3)",
                        borderRadius: 8,
                        padding: "4px 12px",
                        cursor: "pointer",
                        fontWeight: 500,
                      }}
                    >
                      {showPurports.has(verse.id) ? "Hide" : "Show"} Purport
                    </button>
                  )}
                </div>
              </div>

              {/* Purport (expandable) */}
              {showPurports.has(verse.id) && verse.purport && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  transition={{ duration: 0.3 }}
                  style={{
                    margin: "8px 0 0 0",
                    background: "rgba(139, 92, 246, 0.04)",
                    border: "1px solid rgba(196, 181, 253, 0.20)",
                    borderLeft: "3px solid #7C3AED",
                    padding: "20px 24px",
                    borderRadius: 16,
                  }}
                >
                  <p
                    className="font-body"
                    style={{
                      fontSize: 14,
                      fontWeight: 400,
                      lineHeight: 1.8,
                      color: "#374151",
                    }}
                  >
                    {truncate(verse.purport, 1200)}
                  </p>
                </motion.div>
              )}
            </div>
          ))}

          {/* Prose results */}
          {book.prose.map((para) => (
            <div
              key={para.id}
              style={{
                marginBottom: 16,
                background: "rgba(245, 240, 255, 0.35)",
                border: "1px solid rgba(196, 181, 253, 0.2)",
                borderLeft: "3px solid #6366F1",
                padding: "20px 24px",
                borderRadius: 16,
              }}
            >
              {para.chapter_title && (
                <p
                  className="font-body"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "#6B7280",
                    marginBottom: 8,
                  }}
                >
                  {para.chapter_title}
                </p>
              )}
              <p
                className="font-body"
                style={{
                  fontSize: 15,
                  fontWeight: 400,
                  lineHeight: 1.8,
                  color: "#374151",
                }}
              >
                {truncate(para.body_text, 800)}
              </p>
              {para.vedabase_url && (
                <div style={{ textAlign: "right", marginTop: 8 }}>
                  <a
                    href={para.vedabase_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-body"
                    style={{
                      fontSize: 12,
                      color: "#6366F1",
                      textDecoration: "none",
                      fontWeight: 500,
                    }}
                  >
                    Read on Vedabase →
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </motion.section>
  );
}