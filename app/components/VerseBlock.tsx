"use client";

import Link from "next/link";

interface VerseBlockProps {
  sanskrit?: string;
  translation: string;
  verseRef: string;
  verseId?: string;
}

export default function VerseBlock({ sanskrit, translation, verseRef, verseId }: VerseBlockProps) {
  return (
    <div
      style={{
        margin: "20px 0",
        background: "rgba(245, 240, 255, 0.5)",
        border: "1px solid rgba(196, 181, 253, 0.25)",
        borderLeft: "3px solid #8B5CF6",
        padding: "24px 28px",
        borderRadius: 20,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      {sanskrit && (
        <p
          style={{
            fontFamily: "'Noto Serif Devanagari', serif",
            fontSize: "1.15rem",
            lineHeight: 1.9,
            fontWeight: 500,
            color: "#1E1B4B",
            marginBottom: 12,
          }}
        >
          {sanskrit}
        </p>
      )}
      <p
        className="font-display"
        style={{
          fontSize: "1.1rem",
          fontWeight: 400,
          fontStyle: "italic",
          lineHeight: 1.7,
          color: "#1E1B4B",
        }}
      >
        &ldquo;{translation}&rdquo;
      </p>
      <div style={{ textAlign: "right", marginTop: 10 }}>
        <Link
          href={verseId ? `/verse/${verseId}` : "#"}
          className="font-body"
          style={{
            fontSize: 13,
            color: "#8B5CF6",
            textDecoration: "none",
            fontWeight: 500,
            transition: "color 0.3s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#7C3AED";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#8B5CF6";
          }}
        >
          — {verseRef}
        </Link>
      </div>
    </div>
  );
}
