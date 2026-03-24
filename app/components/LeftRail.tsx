"use client";

interface Props {
  keywords: string[];
  synonyms: string[];
  relatedConcepts: string[];
  onSearch: (q: string) => void;
}

export default function LeftRail({ keywords, synonyms, relatedConcepts, onSearch }: Props) {
  return (
    <div className="left-rail" style={{ position: "sticky", top: 80, maxHeight: "calc(100vh - 100px)", overflowY: "auto" }}>
      {/* Related Sanskrit Terms */}
      {synonyms.length > 0 && (
        <div style={{ marginBottom: 20, padding: "16px 18px", borderRadius: 16, background: "rgba(255,255,255,0.6)", border: "1px solid rgba(196,181,253,0.25)", backdropFilter: "blur(10px)" }}>
          <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "#9CA3AF", marginBottom: 10 }}>
            Related Terms
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {synonyms.map(s => (
              <button
                key={s}
                onClick={() => onSearch(s)}
                className="font-body"
                style={{ fontSize: 12, padding: "4px 12px", borderRadius: 100, border: "1px solid rgba(196,181,253,0.3)", background: "rgba(139,92,246,0.06)", color: "#6B7280", cursor: "pointer", transition: "all 0.3s ease", fontWeight: 400 }}
                onMouseEnter={e => { e.currentTarget.style.color = "#7C3AED"; e.currentTarget.style.borderColor = "#C4B5FD"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#6B7280"; e.currentTarget.style.borderColor = "rgba(196,181,253,0.3)"; }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Search Keywords */}
      <div style={{ marginBottom: 20, padding: "16px 18px", borderRadius: 16, background: "rgba(255,255,255,0.6)", border: "1px solid rgba(196,181,253,0.25)", backdropFilter: "blur(10px)" }}>
        <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "#9CA3AF", marginBottom: 10 }}>
          Keywords Used
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {keywords.map(k => (
            <span key={k} className="font-body" style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, background: "rgba(139,92,246,0.08)", color: "#7C3AED", fontWeight: 500 }}>
              {k}
            </span>
          ))}
        </div>
      </div>

      {/* Broader Concepts */}
      {relatedConcepts.length > 0 && (
        <div style={{ padding: "16px 18px", borderRadius: 16, background: "rgba(255,255,255,0.6)", border: "1px solid rgba(196,181,253,0.25)", backdropFilter: "blur(10px)" }}>
          <p className="font-body" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: "#9CA3AF", marginBottom: 10 }}>
            Explore Further
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {relatedConcepts.map(c => (
              <button
                key={c}
                onClick={() => onSearch(`What does Prabhupāda say about ${c}?`)}
                className="font-body"
                style={{ textAlign: "left", fontSize: 13, padding: "8px 12px", borderRadius: 10, border: "none", background: "transparent", color: "#4B5563", cursor: "pointer", transition: "all 0.3s ease", fontWeight: 400 }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.06)"; e.currentTarget.style.color = "#7C3AED"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#4B5563"; }}
              >
                → {c}
              </button>
            ))}
          </div>
        </div>
      )}

      <style jsx>{`
        @media (max-width: 1024px) {
          .left-rail { position: static !important; max-height: none !important; }
        }
      `}</style>
    </div>
  );
}