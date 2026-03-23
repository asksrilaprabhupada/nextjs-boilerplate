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
          ? "linear-gradient(120deg, rgba(255, 248, 252, 0.95), rgba(246, 238, 255, 0.92) 52%, rgba(255, 241, 238, 0.92))"
          : "linear-gradient(120deg, rgba(255, 248, 252, 0.84), rgba(246, 238, 255, 0.8) 52%, rgba(255, 241, 238, 0.78))",
        backdropFilter: "blur(16px) saturate(1.18)",
        WebkitBackdropFilter: "blur(16px) saturate(1.18)",
        borderBottom: scrolled
          ? "1px solid rgba(214, 195, 255, 0.55)"
          : "1px solid rgba(255, 255, 255, 0)",
        padding: "0 clamp(20px, 4vw, 48px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        boxShadow: scrolled ? "0 10px 34px rgba(145, 121, 190, 0.14)" : "none",
        transition: "border-color 0.4s ease, background 0.4s ease, box-shadow 0.4s ease",
      }}
    >
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          className="font-display"
          style={{
            fontSize: "1.4rem",
            fontWeight: 600,
            background: "linear-gradient(135deg, #9D7AF8 0%, #C786B3 48%, #F3958B 100%)",
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            whiteSpace: "nowrap",
            letterSpacing: "-0.01em",
          }}
        >
          Ask Prabhupāda
        </span>
      </div>

      {/* Desktop Nav */}
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
        className="desktop-nav"
      >
        {navItems.map((item) => (
          <button
            key={item}
            onClick={() => onNavChange(item)}
            className="font-body"
            style={{
              padding: "6px 16px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: activeNav === item ? 500 : 400,
              border: "none",
              cursor: "pointer",
              transition: "all 0.3s ease",
              background:
                activeNav === item
                  ? "rgba(214, 195, 255, 0.45)"
                  : "transparent",
              color:
                activeNav === item ? "#7446CB" : "#5B6274",
            }}
            onMouseEnter={(e) => {
              if (activeNav !== item) {
                e.currentTarget.style.color = "#3A315F";
                e.currentTarget.style.background = "rgba(255, 181, 193, 0.24)";
              }
            }}
            onMouseLeave={(e) => {
              if (activeNav !== item) {
                e.currentTarget.style.color = "#5B6274";
                e.currentTarget.style.background = "transparent";
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
            background: "linear-gradient(180deg, rgba(214, 195, 255, 0.7), rgba(255, 181, 193, 0.66))",
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
            color: "#8D86A7",
            transition: "all 0.3s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#4A3D70";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#8D86A7";
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
          color: "#5B6274",
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
            background: "linear-gradient(140deg, rgba(255, 248, 252, 0.97), rgba(246, 238, 255, 0.95) 58%, rgba(255, 241, 238, 0.95))",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderBottom: "1px solid rgba(214, 195, 255, 0.55)",
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
              className="font-body"
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 500,
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                background: activeNav === item ? "rgba(214,195,255,0.45)" : "transparent",
                color: activeNav === item ? "#7446CB" : "#5B6274",
              }}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
