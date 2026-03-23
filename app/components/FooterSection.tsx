"use client";

export default function FooterSection() {
  return (
    <footer
      style={{
        borderTop: "1px solid rgba(196, 181, 253, 0.2)",
        padding: "40px clamp(20px, 5vw, 80px)",
        maxWidth: 1200,
        margin: "0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span
          className="font-display"
          style={{
            fontSize: "1.1rem",
            fontWeight: 600,
            color: "#5B3FA9",
          }}
        >
          Ask Śrīla Prabhupāda
        </span>
        <span
          className="font-body"
          style={{
            fontSize: 13,
            color: "#9CA3AF",
          }}
        >
          &copy; {new Date().getFullYear()} All rights reserved
        </span>
      </div>

      <nav style={{ display: "flex", gap: 24 }}>
        <a
          href="https://github.com/asksrilaprabhupada/nextjs-boilerplate"
          target="_blank"
          rel="noopener noreferrer"
          className="font-body"
          style={{
            fontSize: 14,
            color: "#6B7280",
            textDecoration: "none",
            transition: "color 0.3s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#7C3AED";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#6B7280";
          }}
        >
          GitHub
        </a>
      </nav>
    </footer>
  );
}
