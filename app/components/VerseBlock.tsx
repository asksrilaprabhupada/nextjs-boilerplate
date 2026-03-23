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
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderLeft: "3px solid var(--aurora-violet)",
        padding: "24px 28px",
        borderRadius: 20,
      }}
    >
      {sanskrit && (
        <p
          style={{
            fontFamily: "'Noto Serif Devanagari', serif",
            fontSize: "1.15rem",
            lineHeight: 1.9,
            fontWeight: 500,
            color: "var(--text-primary)",
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
          color: "var(--text-primary)",
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
            color: "var(--aurora-violet)",
            textDecoration: "none",
            fontWeight: 500,
            transition: "color 0.3s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--aurora-teal)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--aurora-violet)";
          }}
        >
          — {verseRef}
        </Link>
      </div>
    </div>
  );
}
