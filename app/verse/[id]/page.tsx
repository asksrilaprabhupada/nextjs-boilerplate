/**
 * page.tsx — Verse Detail Page
 *
 * Displays a single verse with full Sanskrit, transliteration, translation, synonyms, and Srila Prabhupada's purport.
 * Provides a dedicated deep-read page for any verse linked from search results.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface VerseData {
  id: string;
  scripture: string;
  verse_number: string;
  sanskrit_devanagari: string;
  transliteration: string;
  synonyms: string;
  translation: string;
  purport: string;
  chapters?: {
    chapter_number: string;
    canto_or_division: string;
    chapter_title: string;
    scripture: string;
  };
}

const scriptureNames: Record<string, string> = {
  BG: "BHAGAVAD GĪTĀ AS IT IS",
  SB: "ŚRĪMAD BHĀGAVATAM",
  CC: "ŚRĪ CAITANYA CARITĀMṚTA",
};

export default function VerseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [verse, setVerse] = useState<VerseData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchVerse() {
      try {
        const res = await fetch(`/api/verse?id=${params.id}`);
        if (res.ok) {
          const data = await res.json();
          setVerse(data);
        }
      } catch (err) {
        console.error("Failed to fetch verse:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchVerse();
  }, [params.id]);

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
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
      </div>
    );
  }

  if (!verse) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <p className="font-display" style={{ fontSize: "1.2rem", color: "#6B7280" }}>
          Verse not found
        </p>
        <Link
          href="/"
          className="font-body"
          style={{
            fontSize: 14,
            color: "#8B5CF6",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          &larr; Back to search
        </Link>
      </div>
    );
  }

  const chapterInfo = verse.chapters;
  const scriptureName = scriptureNames[verse.scripture] || verse.scripture;
  const cantoPrefix = chapterInfo?.canto_or_division ? `${chapterInfo.canto_or_division}.` : "";
  const chapterNum = chapterInfo?.chapter_number || "";
  const chapterTitle = chapterInfo?.chapter_title || "";

  const synonymEntries = verse.synonyms
    ? verse.synonyms.split(";").map((entry) => {
        const parts = entry.trim().split("\u2014");
        if (parts.length < 2) {
          const dashParts = entry.trim().split("-");
          if (dashParts.length >= 2) {
            return { term: dashParts[0].trim(), meaning: dashParts.slice(1).join("-").trim() };
          }
          return { term: entry.trim(), meaning: "" };
        }
        return { term: parts[0].trim(), meaning: parts.slice(1).join("\u2014").trim() };
      })
    : [];

  return (
    <div
      style={{
        minHeight: "100vh",
        position: "relative",
      }}
    >
      <div
        style={{
          maxWidth: 680,
          margin: "0 auto",
          padding: "100px clamp(20px, 4vw, 40px) 80px",
          position: "relative",
          zIndex: 1,
        }}
      >
        {/* Back link */}
        <button
          onClick={() => router.back()}
          className="font-body"
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: "#8B5CF6",
            background: "none",
            border: "none",
            cursor: "pointer",
            marginBottom: 32,
            padding: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            transition: "opacity 0.3s ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.7"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
        >
          &larr; Back to results
        </button>

        {/* Verse detail card */}
        <div className="aurora-card" style={{ padding: "36px clamp(20px, 3vw, 36px)" }}>
          {/* Scripture name */}
          <div
            className="font-body"
            style={{
              fontSize: 11,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              color: "#6B7280",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ color: "#C4B5FD", opacity: 0.6 }}>&mdash;&mdash;&mdash;</span>
            {scriptureName}
            <span style={{ color: "#C4B5FD", opacity: 0.6 }}>&mdash;&mdash;&mdash;</span>
          </div>

          {/* Chapter and verse number */}
          <h1
            className="font-display"
            style={{
              fontSize: "clamp(1.4rem, 3vw, 1.7rem)",
              fontWeight: 600,
              color: "#1E1B4B",
              marginBottom: 4,
              letterSpacing: "-0.02em",
            }}
          >
            Chapter {cantoPrefix}{chapterNum}, Verse {verse.verse_number}
          </h1>

          {chapterTitle && (
            <p
              className="font-display"
              style={{
                fontSize: "1rem",
                fontStyle: "italic",
                color: "#6B7280",
                marginBottom: 32,
              }}
            >
              {chapterTitle}
            </p>
          )}

          {/* Sanskrit */}
          {verse.sanskrit_devanagari && (
            <div
              style={{
                borderLeft: "3px solid #8B5CF6",
                background: "rgba(139, 92, 246, 0.04)",
                padding: 20,
                borderRadius: "0 14px 14px 0",
                marginBottom: 24,
              }}
            >
              <p
                style={{
                  fontFamily: "'Noto Serif Devanagari', serif",
                  fontSize: "1.15rem",
                  lineHeight: 1.9,
                  fontWeight: 500,
                  color: "#1E1B4B",
                }}
              >
                {verse.sanskrit_devanagari}
              </p>
            </div>
          )}

          {/* Transliteration */}
          {verse.transliteration && (
            <p
              className="font-display"
              style={{
                fontSize: "1rem",
                fontStyle: "italic",
                color: "#6B7280",
                lineHeight: 1.8,
                marginBottom: 32,
              }}
            >
              {verse.transliteration}
            </p>
          )}

          {/* Synonyms */}
          {synonymEntries.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <SectionLabel text="Synonyms" />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: "8px 20px",
                  marginTop: 12,
                }}
              >
                {synonymEntries.map((entry, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                    <span
                      style={{
                        fontFamily: "'Noto Serif Devanagari', serif",
                        fontSize: "0.88rem",
                        fontWeight: 600,
                        color: "#1E1B4B",
                      }}
                    >
                      {entry.term}
                    </span>
                    {entry.meaning && (
                      <span
                        className="font-body"
                        style={{ fontSize: "0.88rem", color: "#6B7280" }}
                      >
                        — {entry.meaning}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Translation */}
          {verse.translation && (
            <div style={{ marginBottom: 32 }}>
              <SectionLabel text="Translation" />
              <p
                className="font-display"
                style={{
                  fontSize: "1.1rem",
                  fontWeight: 400,
                  fontStyle: "italic",
                  lineHeight: 1.7,
                  color: "#1E1B4B",
                  marginTop: 12,
                }}
              >
                &ldquo;{verse.translation}&rdquo;
              </p>
            </div>
          )}

          {/* Purport */}
          {verse.purport && (
            <div style={{ marginBottom: 32 }}>
              <SectionLabel text="Purport" />
              <div
                className="font-body"
                style={{
                  fontSize: 15,
                  fontWeight: 400,
                  lineHeight: 1.8,
                  color: "#374151",
                  marginTop: 12,
                }}
              >
                {verse.purport.split("\n").map((paragraph, i) => (
                  <p key={i} style={{ marginBottom: paragraph.trim() ? 16 : 0 }}>
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{
          width: 20,
          height: 2,
          background: "#8B5CF6",
          borderRadius: 1,
          opacity: 0.5,
        }}
      />
      <span
        className="font-body"
        style={{
          fontSize: 11,
          fontWeight: 500,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: "#6B7280",
        }}
      >
        {text}
      </span>
    </div>
  );
}
