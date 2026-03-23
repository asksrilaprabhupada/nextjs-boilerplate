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
  BG: "BHAGAVAD GITA AS IT IS",
  SB: "SRIMAD BHAGAVATAM",
  CC: "SRI CAITANYA CARITAMRTA",
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
          background: "linear-gradient(170deg, #F8FAFF, #EDE9FE)",
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
            border: "2px solid var(--border-medium)",
            borderTopColor: "var(--indigo)",
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
          background: "linear-gradient(170deg, #F8FAFF, #EDE9FE)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <p className="font-cormorant" style={{ fontSize: "1.2rem", color: "var(--text-muted)" }}>
          Verse not found
        </p>
        <Link
          href="/"
          className="font-satoshi"
          style={{
            fontSize: "0.85rem",
            color: "var(--indigo)",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          ← Back to search
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
        const parts = entry.trim().split("—");
        if (parts.length < 2) {
          const dashParts = entry.trim().split("-");
          if (dashParts.length >= 2) {
            return { term: dashParts[0].trim(), meaning: dashParts.slice(1).join("-").trim() };
          }
          return { term: entry.trim(), meaning: "" };
        }
        return { term: parts[0].trim(), meaning: parts.slice(1).join("—").trim() };
      })
    : [];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(170deg, #F8FAFF 0%, #F1F0FB 50%, #EDE9FE 100%)",
        position: "relative",
      }}
    >
      {/* Ambient orb */}
      <div
        style={{
          position: "fixed",
          top: "20%",
          right: "5%",
          width: 350,
          height: 350,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(79,70,229,0.06) 0%, transparent 65%)",
          animation: "float-orb 20s ease-in-out infinite",
          pointerEvents: "none",
        }}
      />

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
          className="font-satoshi"
          style={{
            fontSize: "0.82rem",
            fontWeight: 500,
            color: "var(--indigo)",
            background: "none",
            border: "none",
            cursor: "pointer",
            marginBottom: 32,
            padding: 0,
            display: "flex",
            alignItems: "center",
            gap: 6,
            transition: "opacity 0.2s ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.7"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
        >
          ← Back to results
        </button>

        {/* Verse detail card — frosted glass */}
        <div
          style={{
            background: "rgba(255, 255, 255, 0.72)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderRadius: "var(--card-radius)",
            border: "1px solid var(--glass-border)",
            boxShadow: "var(--card-shadow)",
            padding: "36px clamp(20px, 3vw, 36px)",
          }}
        >
          {/* Scripture name */}
          <div
            className="font-satoshi"
            style={{
              fontSize: "0.7rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--text-dim)",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ color: "var(--indigo)", opacity: 0.4 }}>───</span>
            {scriptureName}
            <span style={{ color: "var(--indigo)", opacity: 0.4 }}>───</span>
          </div>

          {/* Chapter and verse number */}
          <h1
            className="font-satoshi"
            style={{
              fontSize: "clamp(1.4rem, 3vw, 1.7rem)",
              fontWeight: 900,
              color: "var(--text-primary)",
              marginBottom: 4,
              letterSpacing: "-0.02em",
            }}
          >
            Chapter {cantoPrefix}{chapterNum}, Verse {verse.verse_number}
          </h1>

          {chapterTitle && (
            <p
              className="font-cormorant"
              style={{
                fontSize: "1rem",
                fontStyle: "italic",
                color: "var(--text-muted)",
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
                borderLeft: "3px solid var(--indigo)",
                background: "var(--bg-lavender-soft)",
                padding: 20,
                borderRadius: "0 14px 14px 0",
                marginBottom: 24,
              }}
            >
              <p
                className="font-devanagari"
                style={{
                  fontSize: "1.15rem",
                  lineHeight: 1.9,
                  fontWeight: 500,
                  color: "var(--text-primary)",
                }}
              >
                {verse.sanskrit_devanagari}
              </p>
            </div>
          )}

          {/* Transliteration */}
          {verse.transliteration && (
            <p
              className="font-cormorant"
              style={{
                fontSize: "1rem",
                fontStyle: "italic",
                color: "var(--text-muted)",
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
                      className="font-devanagari"
                      style={{
                        fontSize: "0.88rem",
                        fontWeight: 600,
                        color: "var(--text-primary)",
                      }}
                    >
                      {entry.term}
                    </span>
                    {entry.meaning && (
                      <span
                        className="font-cormorant"
                        style={{ fontSize: "0.88rem", color: "var(--text-muted)" }}
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
                className="font-cormorant"
                style={{
                  fontSize: "1.1rem",
                  fontWeight: 400,
                  fontStyle: "italic",
                  lineHeight: 1.7,
                  color: "var(--text-primary)",
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
                className="font-cormorant"
                style={{
                  fontSize: "0.98rem",
                  fontWeight: 400,
                  lineHeight: 1.8,
                  color: "var(--text-body)",
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
          background: "var(--indigo)",
          borderRadius: 1,
          opacity: 0.5,
        }}
      />
      <span
        className="font-satoshi"
        style={{
          fontSize: "0.7rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-dim)",
        }}
      >
        {text}
      </span>
    </div>
  );
}
