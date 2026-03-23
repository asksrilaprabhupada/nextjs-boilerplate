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
        padding: heroVisible ? "80px clamp(20px, 4vw, 80px) 60px" : "76px 20px 20px",
        position: "relative",
        transition: "all 0.6s var(--ease-smooth)",
        background: heroVisible
          ? "linear-gradient(170deg, #F8FAFF 0%, #F1F0FB 40%, #EDE9FE 80%, #E8E4F8 100%)"
          : "var(--bg-deepest)",
        overflow: "hidden",
      }}
    >
      {/* Ambient floating orbs */}
      {heroVisible && (
        <>
          {/* Large indigo orb — top right */}
          <div
            style={{
              position: "absolute",
              top: "15%",
              right: "10%",
              width: 400,
              height: 400,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(79,70,229,0.08) 0%, rgba(79,70,229,0.02) 50%, transparent 70%)",
              animation: "float-orb 20s ease-in-out infinite",
              pointerEvents: "none",
            }}
          />
          {/* Medium lavender orb — left */}
          <div
            style={{
              position: "absolute",
              top: "40%",
              left: "5%",
              width: 300,
              height: 300,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(139,92,246,0.07) 0%, rgba(139,92,246,0.02) 50%, transparent 70%)",
              animation: "float-orb-2 18s ease-in-out infinite",
              pointerEvents: "none",
            }}
          />
          {/* Small accent orb — bottom center */}
          <div
            style={{
              position: "absolute",
              bottom: "10%",
              left: "55%",
              width: 250,
              height: 250,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 60%)",
              animation: "float-orb 22s ease-in-out infinite reverse",
              pointerEvents: "none",
            }}
          />
        </>
      )}

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
          maxWidth: heroVisible ? 660 : 620,
        }}
      >
        {/* Badge */}
        {heroVisible && (
          <div
            className="font-satoshi animate-fade-in-up"
            style={{
              animationDelay: "0.15s",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "5px 14px 5px 9px",
              borderRadius: 100,
              background: "var(--indigo-soft)",
              border: "1px solid rgba(79,70,229,0.12)",
              marginBottom: 28,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--indigo)",
                animation: "pulse-dot 2.5s ease-in-out infinite",
              }}
            />
            <span
              style={{
                fontSize: "0.7rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--indigo)",
              }}
            >
              Scripture-grounded answers
            </span>
          </div>
        )}

        {/* Title — Satoshi 900 */}
        {heroVisible && (
          <h1
            className="font-satoshi animate-fade-in-up"
            style={{
              animationDelay: "0.3s",
              fontSize: "clamp(2.2rem, 5vw, 3.8rem)",
              fontWeight: 900,
              textAlign: "center",
              letterSpacing: "-0.04em",
              lineHeight: 1.1,
              marginBottom: 18,
              color: "var(--text-primary)",
            }}
          >
            Every answer from
            <br />
            <span
              style={{
                background: "linear-gradient(135deg, var(--indigo), #8B5CF6)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              Srila Prabhupada&apos;s
            </span>{" "}
            words
          </h1>
        )}

        {/* Subtitle — Satoshi 400 */}
        {heroVisible && (
          <p
            className="font-satoshi animate-fade-in-up"
            style={{
              animationDelay: "0.45s",
              fontSize: "clamp(0.9rem, 1.8vw, 1.02rem)",
              fontWeight: 400,
              color: "var(--text-muted)",
              textAlign: "center",
              maxWidth: 460,
              lineHeight: 1.65,
              marginBottom: 36,
            }}
          >
            Search across Bhagavad Gita, Srimad Bhagavatam, and Caitanya Caritamrta.
            Every response traced to exact verses.
          </p>
        )}

        {/* Search Input — frosted glass */}
        <form
          onSubmit={handleSubmit}
          className="animate-fade-in-up"
          style={{
            animationDelay: heroVisible ? "0.6s" : "0s",
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
            className="font-satoshi"
            style={{
              width: "100%",
              padding: "16px 54px 16px 22px",
              fontSize: "0.98rem",
              fontWeight: 400,
              border: "1.5px solid rgba(79,70,229,0.12)",
              borderRadius: 14,
              background: "rgba(255,255,255,0.8)",
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              color: "var(--text-primary)",
              outline: "none",
              transition: "border-color 0.3s ease, box-shadow 0.3s ease",
              boxShadow: "var(--glass-shadow)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--indigo)";
              e.currentTarget.style.boxShadow =
                "var(--shadow-medium), 0 0 0 3px rgba(79,70,229,0.08)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "rgba(79,70,229,0.12)";
              e.currentTarget.style.boxShadow = "var(--glass-shadow)";
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
              background: "linear-gradient(135deg, var(--indigo), var(--indigo-light))",
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
                e.currentTarget.style.boxShadow = "var(--shadow-indigo-glow)";
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

        {/* Topic Pills — frosted glass chips */}
        {heroVisible && (
          <div
            className="animate-fade-in-up"
            style={{
              animationDelay: "0.75s",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "center",
              marginTop: 22,
              maxWidth: 620,
            }}
          >
            {topicPills.map((pill) => (
              <button
                key={pill}
                onClick={() => handlePillClick(pill)}
                className="font-satoshi"
                style={{
                  padding: "7px 15px",
                  borderRadius: 100,
                  border: "1px solid rgba(79,70,229,0.10)",
                  background: "rgba(255,255,255,0.6)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                  fontSize: "0.8rem",
                  fontWeight: 500,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  transition: "all 0.25s ease",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--indigo)";
                  e.currentTarget.style.color = "var(--indigo)";
                  e.currentTarget.style.background = "rgba(79,70,229,0.06)";
                  e.currentTarget.style.transform = "translateY(-1px)";
                  e.currentTarget.style.boxShadow = "0 4px 14px rgba(79,70,229,0.12)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "rgba(79,70,229,0.10)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.background = "rgba(255,255,255,0.6)";
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.boxShadow = "none";
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
