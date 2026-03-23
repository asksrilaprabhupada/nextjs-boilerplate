"use client";

import { useState, useEffect } from "react";

interface HeaderProps {
  activeNav: string;
  onNavChange: (nav: string) => void;
}

export default function Header({ activeNav, onNavChange }: HeaderProps) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const navItems = ["Search", "About", "Donate", "Contact"];

  return (
    <header
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        height: 60,
        background: scrolled
          ? "rgba(248, 250, 255, 0.85)"
          : "rgba(248, 250, 255, 0.5)",
        backdropFilter: "blur(24px) saturate(1.5)",
        WebkitBackdropFilter: "blur(24px) saturate(1.5)",
        borderBottom: scrolled
          ? "1px solid rgba(79, 70, 229, 0.08)"
          : "1px solid transparent",
        padding: "0 clamp(20px, 4vw, 48px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        transition: "all 0.4s ease",
      }}
    >
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: "linear-gradient(135deg, var(--indigo), var(--indigo-light))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 10px rgba(79,70,229,0.3)",
            flexShrink: 0,
          }}
        >
          <span className="font-devanagari" style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>
            प्र
          </span>
        </div>
        <span
          className="font-satoshi"
          style={{
            fontSize: "0.95rem",
            fontWeight: 700,
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
            letterSpacing: "-0.02em",
          }}
        >
          Ask Srila Prabhupada
        </span>
      </div>

      {/* Desktop Nav */}
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
        }}
        className="desktop-nav"
      >
        {navItems.map((item) => (
          <button
            key={item}
            onClick={() => onNavChange(item)}
            className="font-satoshi"
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              fontSize: "0.8rem",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              transition: "all 0.25s ease",
              background:
                activeNav === item
                  ? "var(--indigo)"
                  : "transparent",
              color:
                activeNav === item ? "#fff" : "var(--text-muted)",
            }}
            onMouseEnter={(e) => {
              if (activeNav !== item) {
                e.currentTarget.style.background = "var(--indigo-soft)";
                e.currentTarget.style.color = "var(--indigo)";
              }
            }}
            onMouseLeave={(e) => {
              if (activeNav !== item) {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--text-muted)";
              }
            }}
          >
            {item}
          </button>
        ))}

        {/* Divider */}
        <div
          style={{
            width: 1,
            height: 18,
            background: "var(--border-medium)",
            margin: "0 8px",
          }}
        />

        {/* GitHub icon */}
        <a
          href="https://github.com/asksrilaprabhupada/nextjs-boilerplate"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View on GitHub"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-dim)",
            transition: "all 0.25s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--indigo-soft)";
            e.currentTarget.style.color = "var(--indigo)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-dim)";
          }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
        </a>
      </nav>

      {/* Mobile hamburger */}
      <button
        className="mobile-menu-btn"
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        aria-label="Toggle menu"
        style={{
          display: "none",
          width: 34,
          height: 34,
          borderRadius: 8,
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {mobileMenuOpen ? (
            <path d="M6 6l12 12M6 18L18 6" />
          ) : (
            <path d="M3 12h18M3 6h18M3 18h18" />
          )}
        </svg>
      </button>

      {/* Mobile dropdown */}
      {mobileMenuOpen && (
        <div
          style={{
            position: "absolute",
            top: 60,
            left: 0,
            right: 0,
            background: "rgba(248, 250, 255, 0.96)",
            backdropFilter: "blur(24px)",
            borderBottom: "1px solid var(--border-subtle)",
            padding: "8px 16px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {navItems.map((item) => (
            <button
              key={item}
              onClick={() => {
                onNavChange(item);
                setMobileMenuOpen(false);
              }}
              className="font-satoshi"
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                fontSize: "0.88rem",
                fontWeight: 500,
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                background: activeNav === item ? "var(--indigo)" : "transparent",
                color: activeNav === item ? "#fff" : "var(--text-muted)",
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}

      <style jsx>{`
        @media (max-width: 768px) {
          .desktop-nav {
            display: none !important;
          }
          .mobile-menu-btn {
            display: flex !important;
          }
        }
      `}</style>
    </header>
  );
}
