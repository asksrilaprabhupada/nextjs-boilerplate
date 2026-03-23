"use client";

interface FooterProps {
  onNavChange: (nav: string) => void;
}

export default function Footer({ onNavChange }: FooterProps) {
  const columnHeaderStyle: React.CSSProperties = {
    fontSize: "0.68rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--text-secondary)",
    marginBottom: 12,
  };

  const linkStyle: React.CSSProperties = {
    fontSize: "0.82rem",
    color: "var(--text-muted)",
    textDecoration: "none",
    cursor: "pointer",
    transition: "color 0.2s ease",
    background: "none",
    border: "none",
    padding: 0,
    fontFamily: "'DM Sans', sans-serif",
    textAlign: "left" as const,
  };

  return (
    <footer
      style={{
        borderTop: "1px solid var(--border-subtle)",
        background: "var(--bg-deepest)",
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "48px clamp(20px, 4vw, 48px) 32px",
        }}
      >
        {/* Main footer grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.5fr 1fr 1fr 1fr",
            gap: 40,
            marginBottom: 32,
          }}
          className="footer-grid"
        >
          {/* Brand */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: "linear-gradient(135deg, var(--saffron), var(--rose-gold))",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <span className="font-devanagari" style={{ color: "#fff", fontSize: 12 }}>
                  प्र
                </span>
              </div>
              <span
                className="font-cormorant"
                style={{ fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)" }}
              >
                Ask Śrīla Prabhupāda
              </span>
            </div>
            <p
              className="font-cormorant"
              style={{
                fontSize: "0.82rem",
                color: "var(--text-muted)",
                lineHeight: 1.6,
                maxWidth: 320,
              }}
            >
              A devotional search platform grounded in the teachings of His Divine Grace
              A.C. Bhaktivedanta Swami Prabhupāda.
            </p>
          </div>

          {/* Platform */}
          <div>
            <h4 className="font-dm-sans" style={columnHeaderStyle}>
              Platform
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button style={linkStyle} onClick={() => onNavChange("Search")}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--saffron)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
                Search
              </button>
              <button style={linkStyle} onClick={() => onNavChange("About")}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--saffron)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
                About
              </button>
              <a href="https://github.com" target="_blank" rel="noopener noreferrer" style={linkStyle}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--saffron)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
                GitHub
              </a>
            </div>
          </div>

          {/* Community */}
          <div>
            <h4 className="font-dm-sans" style={columnHeaderStyle}>
              Community
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button style={linkStyle} onClick={() => onNavChange("Donate")}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--saffron)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
                Donate
              </button>
              <button style={linkStyle} onClick={() => onNavChange("Contact")}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--saffron)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
                Contact
              </button>
              <a href="https://github.com" target="_blank" rel="noopener noreferrer" style={linkStyle}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--saffron)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}>
                Feature Request
              </a>
            </div>
          </div>

          {/* Sources */}
          <div>
            <h4 className="font-dm-sans" style={columnHeaderStyle}>
              Sources
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="font-dm-sans" style={{ ...linkStyle, cursor: "default" }}>
                Bhagavad Gītā
              </span>
              <span className="font-dm-sans" style={{ ...linkStyle, cursor: "default" }}>
                Śrīmad Bhāgavatam
              </span>
              <span className="font-dm-sans" style={{ ...linkStyle, cursor: "default" }}>
                Caitanya Caritāmṛta
              </span>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 24,
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <p
            className="font-dm-sans"
            style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}
          >
            © 2026 Ask Śrīla Prabhupāda. All glories to Śrī Guru and Gaurāṅga.
          </p>
          <p
            className="font-cormorant"
            style={{
              fontSize: "0.72rem",
              fontStyle: "italic",
              color: "var(--text-dim)",
            }}
          >
            Built with devotion
          </p>
        </div>
      </div>

      <style jsx>{`
        @media (max-width: 768px) {
          .footer-grid {
            grid-template-columns: 1fr 1fr !important;
          }
        }
        @media (max-width: 480px) {
          .footer-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </footer>
  );
}
