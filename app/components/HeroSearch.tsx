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

  useEffect(() => {
    if (hasResults) {
      setHeroVisible(false);
    }
  }, [hasResults]);

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

  return (
    <section
      style={{
        minHeight: heroVisible ? "100vh" : "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: heroVisible ? "center" : "flex-start",
        padding: heroVisible ? "80px clamp(20px, 4vw, 80px) 60px" : "80px 20px 20px",
        position: "relative",
        transition: "all 0.6s var(--ease-smooth)",
      }}
    >
      {/* Background glow */}
      {heroVisible && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 800,
            height: 600,
            background: "radial-gradient(ellipse, rgba(232,130,12,0.05) 0%, transparent 70%)",
            animation: "breathe 8s ease-in-out infinite",
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
          maxWidth: heroVisible ? 680 : 640,
        }}
      >
        {/* Badge */}
        {heroVisible && (
          <div
            className="font-dm-sans animate-fade-in-up"
            style={{
              animationDelay: "0.2s",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 14px 5px 8px",
              borderRadius: 100,
              background: "rgba(232,130,12,0.08)",
              border: "1px solid rgba(232,130,12,0.12)",
              marginBottom: 24,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--saffron)",
                animation: "pulse-dot 2s ease-in-out infinite",
              }}
            />
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--saffron)",
              }}
            >
              Scripture-grounded answers
            </span>
          </div>
        )}

        {/* Title */}
        {heroVisible && (
          <h1
            className="font-cormorant animate-fade-in-up"
            style={{
              animationDelay: "0.35s",
              fontSize: "clamp(2.2rem, 5vw, 3.8rem)",
              fontWeight: 400,
              textAlign: "center",
              letterSpacing: "-0.025em",
              lineHeight: 1.2,
              marginBottom: 16,
            }}
          >
            Every answer from
            <br />
            <span style={{ fontStyle: "italic", color: "var(--saffron)", fontWeight: 500 }}>
              Śrīla Prabhupāda&apos;s
            </span>{" "}
            words
          </h1>
        )}

        {/* Subtitle */}
        {heroVisible && (
          <p
            className="font-dm-sans animate-fade-in-up"
            style={{
              animationDelay: "0.5s",
              fontSize: "clamp(0.9rem, 2vw, 1.02rem)",
              color: "var(--text-muted)",
              textAlign: "center",
              maxWidth: 480,
              lineHeight: 1.6,
              marginBottom: 32,
            }}
          >
            Search across Bhagavad Gītā, Śrīmad Bhāgavatam, and Caitanya Caritāmṛta.
            Every response traced to exact verses — no hallucinations.
          </p>
        )}

        {/* Search Input */}
        <form
          onSubmit={handleSubmit}
          className="animate-fade-in-up"
          style={{
            animationDelay: heroVisible ? "0.65s" : "0s",
            width: "100%",
            maxWidth: 640,
            position: "relative",
            ...(hasResults
              ? {
                  position: "sticky" as const,
                  top: 72,
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
            className="font-dm-sans"
            style={{
              width: "100%",
              padding: "18px 56px 18px 24px",
              fontSize: "1.02rem",
              fontWeight: 400,
              border: "1.5px solid var(--border-medium)",
              borderRadius: 16,
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              outline: "none",
              transition: "border-color 0.3s ease, box-shadow 0.3s ease",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--saffron)";
              e.currentTarget.style.boxShadow =
                "var(--shadow-medium), 0 0 0 4px rgba(232,130,12,0.1)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border-medium)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />
          <button
            type="submit"
            disabled={isSearching || !query.trim()}
            aria-label="Search"
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              width: 40,
              height: 40,
              borderRadius: 12,
              background: "var(--saffron)",
              border: "none",
              cursor: query.trim() ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "transform 0.2s ease, box-shadow 0.2s ease",
              opacity: query.trim() ? 1 : 0.5,
            }}
            onMouseEnter={(e) => {
              if (query.trim()) {
                e.currentTarget.style.transform = "translateY(-50%) scale(1.05)";
                e.currentTarget.style.boxShadow = "var(--shadow-saffron-glow)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(-50%)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            {isSearching ? (
              <svg width="18" height="18" viewBox="0 0 24 24" style={{ animation: "rotate-mandala 1s linear infinite" }}>
                <circle cx="12" cy="12" r="10" fill="none" stroke="#080E1A" strokeWidth="2" strokeDasharray="30 70" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14M12 5l7 7-7 7" stroke="#080E1A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </form>

        {/* Topic Pills */}
        {heroVisible && (
          <div
            className="animate-fade-in-up"
            style={{
              animationDelay: "0.8s",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "center",
              marginTop: 20,
              maxWidth: 640,
            }}
          >
            {topicPills.map((pill) => (
              <button
                key={pill}
                onClick={() => handlePillClick(pill)}
                className="font-dm-sans"
                style={{
                  padding: "7px 16px",
                  borderRadius: 100,
                  border: "1px solid var(--border-medium)",
                  background: "var(--bg-elevated)",
                  fontSize: "0.82rem",
                  fontWeight: 500,
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--saffron)";
                  e.currentTarget.style.color = "var(--saffron)";
                  e.currentTarget.style.background = "rgba(232,130,12,0.05)";
                  e.currentTarget.style.transform = "translateY(-2px)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-medium)";
                  e.currentTarget.style.color = "var(--text-secondary)";
                  e.currentTarget.style.background = "var(--bg-elevated)";
                  e.currentTarget.style.transform = "translateY(0)";
                }}
              >
                ✦ {pill}
              </button>
            ))}
          </div>
        )}

        {/* Source Badges */}
        {heroVisible && (
          <div
            className="animate-fade-in-up"
            style={{
              animationDelay: "0.95s",
              display: "flex",
              gap: 24,
              justifyContent: "center",
              marginTop: 48,
              opacity: 0.4,
            }}
          >
            {[
              { name: "Bhagavad Gītā", count: "657 verses" },
              { name: "Śrīmad Bhāgavatam", count: "13,004 verses" },
              { name: "Caitanya Caritāmṛta", count: "11,359 verses" },
            ].map((source) => (
              <div
                key={source.name}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                  transition: "opacity 0.3s ease",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget.parentElement as HTMLElement).style.opacity = "0.7";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget.parentElement as HTMLElement).style.opacity = "0.4";
                }}
              >
                <span
                  className="font-dm-sans"
                  style={{
                    fontSize: "0.68rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--text-primary)",
                  }}
                >
                  {source.name}
                </span>
                <span
                  className="font-dm-sans"
                  style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}
                >
                  {source.count}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
