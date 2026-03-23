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
            background: "linear-gradient(135deg, #7C3AED, #6366F1)",
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
            color: "#9CA3AF",
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
            {link}
          </a>
        ))}
      </nav>
    </footer>
  );
}
