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
    <div className="verse-block" style={{ margin: "20px 0" }}>
      {sanskrit && (
        <p
          className="font-devanagari"
          style={{
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
        className="font-cormorant"
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
          className="font-satoshi"
          style={{
            fontSize: "0.75rem",
            color: "var(--indigo)",
            textDecoration: "none",
            fontWeight: 500,
            transition: "color 0.2s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--indigo-light)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--indigo)";
          }}
        >
          — {verseRef}
        </Link>
      </div>
    </div>
  );
}
