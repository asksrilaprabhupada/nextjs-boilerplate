/**
 * 02-footer.tsx — Site Footer
 *
 * Renders the bottom section with branding, navigation links, and credits.
 * Closes out every page with consistent site-wide footer content.
 */
"use client";

export default function FooterSection() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--border-hair)",
        padding: "20px clamp(20px, 5vw, 80px)",
        maxWidth: 1200,
        margin: "0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 16,
      }}
    >
      <span
        className="font-body"
        style={{
          fontSize: 13,
          color: "var(--ink-muted)",
        }}
      >
        &copy; {new Date().getFullYear()} All rights reserved
      </span>

      <a
        href="https://github.com/asksrilaprabhupada/nextjs-boilerplate"
        target="_blank"
        rel="noopener noreferrer"
        className="font-body"
        style={{
          fontSize: 13,
          color: "var(--ink-muted)",
          textDecoration: "none",
          transition: "color 0.3s ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--accent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--ink-muted)";
        }}
      >
        GitHub
      </a>
    </footer>
  );
}
