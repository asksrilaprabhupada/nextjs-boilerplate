"use client";

import type { Citation, BookGroup } from "./NarrativeResponse";

interface Props {
  citations: Citation[];
  books: BookGroup[];
  onWantMore: (book: BookGroup) => void;
}

export default function RightRail({ citations, books, onWantMore }: Props) {
  // Group citations by book
  const byBook: Record<string, Citation[]> = {};
  for (const c of citations) {
    if (!byBook[c.book]) byBook[c.book] = [];
    byBook[c.book].push(c);
  }

  return (
    <div className="right-rail" style={{ position: "sticky", top: 80, maxHeight: "calc(100vh - 100px)", overflowY: "auto" }}>
      {/* Source count */}
      <div style={{ marginBottom: 16, padding: "14px 18px", borderRadius: 16, background: "linear-gradient(135deg, rgba(139,92,246,0.08), rgba(99,102,241,0.06))", border: "1px solid rgba(196,181,253,0.3)" }}>
        <p className="font-body" style={{ fontSize: 24, fontWeight: 700, color: "#7C3AED", lineHeight: 1 }}>
          {citations.length}
        </p>
        <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "#6B7280", marginTop: 4 }}>
          Sources Found
        </p>
      </div>

      {/* Book sections with "Want More" */}
      {books.map(book => {
        const bookCitations = byBook[book.name] || [];
        const total = book.verses.length + book.prose.length;
        if (total === 0) return null;

        return (
          <div key={book.slug} style={{ marginBottom: 14, padding: "14px 16px", borderRadius: 14, background: "rgba(255,255,255,0.6)", border: "1px solid rgba(196,181,253,0.2)", backdropFilter: "blur(10px)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <p className="font-body" style={{ fontSize: 12, fontWeight: 600, color: "#1E1B4B" }}>
                {book.name}
              </p>
              <span className="font-body" style={{ fontSize: 11, color: "#6B7280", fontWeight: 500 }}>
                {total}
              </span>
            </div>

            {/* Citation links */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
              {bookCitations.slice(0, 5).map((c, i) => (
                <a
                  key={i}
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-body"
                  style={{ fontSize: 12, color: "#8B5CF6", textDecoration: "none", padding: "3px 0", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "color 0.2s" }}
                  onMouseEnter={e => { e.currentTarget.style.color = "#6366F1"; e.currentTarget.style.textDecoration = "underline"; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "#8B5CF6"; e.currentTarget.style.textDecoration = "none"; }}
                >
                  {c.type === "verse" ? `📖 ${c.ref}` : `📄 ${c.title || c.ref}`}
                </a>
              ))}
              {bookCitations.length > 5 && (
                <span className="font-body" style={{ fontSize: 11, color: "#6B7280" }}>
                  +{bookCitations.length - 5} more
                </span>
              )}
            </div>

            {/* Want More button */}
            <button
              onClick={() => onWantMore(book)}
              className="font-body"
              style={{ width: "100%", padding: "7px 12px", borderRadius: 8, border: "1px dashed rgba(196,181,253,0.4)", background: "rgba(139,92,246,0.04)", fontSize: 12, fontWeight: 600, color: "#7C3AED", cursor: "pointer", transition: "all 0.3s ease" }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.1)"; e.currentTarget.style.borderColor = "#8B5CF6"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "rgba(139,92,246,0.04)"; e.currentTarget.style.borderColor = "rgba(196,181,253,0.4)"; }}
            >
              View all {total} sources →
            </button>
          </div>
        );
      })}

      <style jsx>{`
        @media (max-width: 1024px) {
          .right-rail { position: static !important; max-height: none !important; }
        }
      `}</style>
    </div>
  );
}