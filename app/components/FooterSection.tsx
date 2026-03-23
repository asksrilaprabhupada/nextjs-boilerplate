"use client";

export default function FooterSection() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--border-subtle)",
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
            background: "linear-gradient(135deg, var(--aurora-violet), var(--aurora-teal))",
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          Ask Prabhupāda
        </span>
        <span
          className="font-body"
          style={{
            fontSize: 13,
            color: "var(--text-muted)",
          }}
        >
          &copy; {new Date().getFullYear()} All rights reserved
        </span>
      </div>

      <nav style={{ display: "flex", gap: 24 }}>
        {["About", "GitHub", "Contact"].map((link) => (
          <a
            key={link}
            href={link === "GitHub" ? "https://github.com/asksrilaprabhupada/nextjs-boilerplate" : "#"}
            target={link === "GitHub" ? "_blank" : undefined}
            rel={link === "GitHub" ? "noopener noreferrer" : undefined}
            className="font-body"
            style={{
              fontSize: 14,
              color: "var(--text-secondary)",
              textDecoration: "none",
              transition: "color 0.3s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            {link}
          </a>
        ))}
      </nav>
    </footer>
  );
}
