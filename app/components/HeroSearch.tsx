"use client";

import { useState, useRef, useEffect } from "react";

const topicPills = [
  "What is karma?",
  "The nature of the soul",
  "How to practice devotion?",
  "How to control the mind?",
  "What happens after death?",
  "What is the purpose of life?",
  "How to be free from suffering?",
];

interface HeroSearchProps {
  onSearch: (query: string) => void;
  isSearching: boolean;
  hasResults: boolean;
}

export default function HeroSearch({ onSearch, isSearching, hasResults }: HeroSearchProps) {
  const [query, setQuery] = useState("");
  const [heroVisible, setHeroVisible] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const [animatedIn, setAnimatedIn] = useState(false);

  useEffect(() => {
    if (hasResults) {
      setHeroVisible(false);
    }
  }, [hasResults]);

  useEffect(() => {
    const t = setTimeout(() => setAnimatedIn(true), 100);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
    }
  };

  const handlePillClick = (topic: string) => {
    setQuery(topic);
    onSearch(topic);
  };

  const stagger = (i: number) => ({
    opacity: animatedIn ? 1 : 0,
    transform: animatedIn ? "translateY(0)" : "translateY(32px)",
    transition: `opacity 0.8s cubic-bezier(0.16,1,0.3,1) ${i * 100}ms, transform 0.8s cubic-bezier(0.16,1,0.3,1) ${i * 100}ms`,
  });

  return (
    <section
      style={{
        minHeight: heroVisible ? "100vh" : "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: heroVisible ? "center" : "flex-start",
        padding: heroVisible ? "80px clamp(20px, 4vw, 80px) 60px" : "76px 20px 20px",
        position: "relative",
        transition: "all 0.6s var(--ease-out-expo)",
        overflow: "hidden",
      }}
    >
      {/* Floating blurred orb behind content */}
      {heroVisible && (
        <div
          style={{
            position: "absolute",
            top: "30%",
            left: "50%",
            transform: "translateX(-50%)",
            width: 500,
            height: 500,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(139,92,246,0.2) 0%, rgba(217,70,239,0.1) 40%, rgba(45,212,191,0.05) 70%, transparent 100%)",
            filter: "blur(60px)",
            animation: "floatOrb 20s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />
      )}

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
          maxWidth: heroVisible ? 700 : 620,
        }}
      >
        {/* Badge */}
        {heroVisible && (
          <div
            className="font-body"
            style={{
              ...stagger(0),
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 16px 6px 10px",
              borderRadius: 100,
              background: "rgba(139,92,246,0.1)",
              border: "1px solid rgba(139,92,246,0.2)",
              marginBottom: 32,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--aurora-teal)",
                animation: "pulseDot 2.5s ease-in-out infinite",
              }}
            />
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.15em",
                color: "var(--aurora-teal)",
              }}
            >
              Scripture-grounded answers
            </span>
          </div>
        )}

        {/* Hero Headline — Instrument Serif */}
        {heroVisible && (
          <h1
            className="font-display"
            style={{
              ...stagger(1),
              fontSize: "clamp(48px, 7vw, 88px)",
              fontWeight: 400,
              textAlign: "center",
              letterSpacing: "-0.03em",
              lineHeight: 1.05,
              marginBottom: 24,
              color: "var(--text-primary)",
            }}
          >
            Every answer from
            <br />
            <span className="gradient-text">
              Prabhupāda&apos;s
            </span>{" "}
            words
          </h1>
        )}

        {/* Subtitle — DM Sans 300 */}
        {heroVisible && (
          <p
            className="font-body"
            style={{
              ...stagger(2),
              fontSize: "clamp(16px, 1.8vw, 17px)",
              fontWeight: 300,
              color: "var(--text-secondary)",
              textAlign: "center",
              maxWidth: 540,
              lineHeight: 1.7,
              marginBottom: 40,
            }}
          >
            Search across Bhagavad Gītā, Śrīmad Bhāgavatam, and Caitanya Caritāmṛta.
            Every response traced to exact verses.
          </p>
        )}

        {/* Buttons */}
        {heroVisible && (
          <div
            style={{
              ...stagger(3),
              display: "flex",
              gap: 12,
              marginBottom: 40,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <button
              className="btn-primary"
              onClick={() => inputRef.current?.focus()}
            >
              <span>Start Searching</span>
            </button>
            <a
              href="https://github.com/asksrilaprabhupada/nextjs-boilerplate"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
            >
              View on GitHub
            </a>
          </div>
        )}

        {/* Search Input */}
        <form
          onSubmit={handleSubmit}
          style={{
            ...stagger(4),
            width: "100%",
            maxWidth: 620,
            position: "relative",
            ...(hasResults
              ? {
                  position: "sticky" as const,
                  top: 68,
                  zIndex: 50,
                }
              : {}),
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask anything about the scriptures..."
            aria-label="Search the scriptures"
            className="font-body"
            style={{
              width: "100%",
              padding: "16px 54px 16px 22px",
              fontSize: 16,
              fontWeight: 400,
              border: "1px solid var(--border-subtle)",
              borderRadius: 14,
              background: "var(--bg-input)",
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              color: "var(--text-primary)",
              outline: "none",
              transition: "border-color 0.3s ease, box-shadow 0.3s ease",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--aurora-violet)";
              e.currentTarget.style.boxShadow = "0 0 0 3px rgba(139,92,246,0.15)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border-subtle)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />
          <button
            type="submit"
            disabled={isSearching || !query.trim()}
            aria-label="Search"
            style={{
              position: "absolute",
              right: 7,
              top: "50%",
              transform: "translateY(-50%)",
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "linear-gradient(135deg, var(--aurora-violet), var(--aurora-fuchsia))",
              border: "none",
              cursor: query.trim() ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease",
              opacity: query.trim() ? 1 : 0.4,
            }}
            onMouseEnter={(e) => {
              if (query.trim()) {
                e.currentTarget.style.transform = "translateY(-50%) scale(1.06)";
                e.currentTarget.style.boxShadow = "0 4px 24px rgba(139,92,246,0.3)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(-50%)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            {isSearching ? (
              <svg width="16" height="16" viewBox="0 0 24 24" style={{ animation: "spin 0.8s linear infinite" }}>
                <circle cx="12" cy="12" r="10" fill="none" stroke="#fff" strokeWidth="2" strokeDasharray="30 70" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14M12 5l7 7-7 7" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </form>

        {/* Topic Pills */}
        {heroVisible && (
          <div
            style={{
              ...stagger(5),
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "center",
              marginTop: 24,
              maxWidth: 620,
            }}
          >
            {topicPills.map((pill) => (
              <button
                key={pill}
                onClick={() => handlePillClick(pill)}
                className="font-body"
                style={{
                  padding: "7px 16px",
                  borderRadius: 100,
                  border: "1px solid var(--border-subtle)",
                  background: "transparent",
                  fontSize: 13,
                  fontWeight: 400,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--aurora-violet)";
                  e.currentTarget.style.color = "var(--text-primary)";
                  e.currentTarget.style.background = "rgba(139,92,246,0.08)";
                  e.currentTarget.style.transform = "translateY(-2px)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-subtle)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.transform = "translateY(0)";
                }}
              >
                {pill}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
